import { newQueue } from "@henrygd/queue";
import { parseArgs } from "@std/cli/parse-args";
import { WalkEntry } from "@std/fs/walk";
import { resolve } from "@std/path";

import { MultiBarWrapper } from "./utils/progressWrapper.ts";
import {
  checksum,
  getChecksumCacheKey,
  pruneMissingChecksums,
} from "./utils/checksums.ts";
import {
  cacheFileName,
  COMMANDS,
  logFileName,
  parseOptions,
} from "./utils/constants.ts";
import {
  cleanupActivePartFilesSync,
  createChecksumFlusher,
  downloadItems,
  getActivePartFiles,
  verifyItems,
} from "./utils/download.ts";
import {
  clean,
  computeAndPrintDiff,
  deleteEmptyFolders,
  exportCatalog,
  generateAudioPlaylists,
  isChecksumCacheDirty,
  loadChecksumCache,
  printBundlesList,
  printLibraryStats,
  printRunSummary,
  printUnclaimedReport,
  pruneTrash,
  readJsonFile,
  walkExistingFiles,
  writeExternalLinkSidecars,
  writeJsonFile,
  writeJsonFileSync,
} from "./utils/fileUtils.ts";
import { checkOptions, generateShellCompletion } from "./utils/options.ts";
import {
  filterAudio,
  filterBundles,
  filterEbooks,
  filterVideos,
} from "./utils/orders.ts";

import {
  getAllBundles,
  getAllTroves,
  sendCompletionWebhook,
} from "./utils/web.ts";
import { DownloadInfo, Options, Totals } from "./types/general.ts";
import { Bundle, Checksums } from "./types/bundle.ts";
import { Trove } from "./types/trove.ts";
import { filterTroves } from "./utils/troves.ts";

interface CommandBehavior {
  readOnly?: boolean;
  cleanupOnly?: boolean;
  skipChecksumSave?: boolean;
  skipChecksumLoad?: boolean;
  printsJsonDirectly?: boolean;
}

const COMMAND_BEHAVIOR: Record<string, CommandBehavior> = {
  [COMMANDS.stats]: {
    readOnly: true,
    skipChecksumSave: true,
    printsJsonDirectly: true,
  },
  [COMMANDS.list]: {
    readOnly: true,
    skipChecksumSave: true,
    printsJsonDirectly: true,
  },
  [COMMANDS.bundles]: {
    readOnly: true,
    skipChecksumSave: true,
    printsJsonDirectly: true,
  },
  [COMMANDS.unclaimed]: {
    readOnly: true,
    skipChecksumSave: true,
    skipChecksumLoad: true,
    printsJsonDirectly: true,
  },
  [COMMANDS.export]: { readOnly: true, skipChecksumSave: true },
  [COMMANDS.checksums]: { readOnly: true },
  [COMMANDS.verify]: { readOnly: true },
  [COMMANDS.repair]: { readOnly: true },
  [COMMANDS.cleanup]: { cleanupOnly: true },
  [COMMANDS.cleanupAudio]: { cleanupOnly: true },
  [COMMANDS.cleanupEbooks]: { cleanupOnly: true },
  [COMMANDS.cleanupTrash]: {
    readOnly: true,
    skipChecksumSave: true,
    skipChecksumLoad: true,
  },
  [COMMANDS.cleanupTrove]: { cleanupOnly: true },
  [COMMANDS.cleanupVideos]: { cleanupOnly: true },
};

async function main(): Promise<void> {
  // Parse and check options
  const options: Options = parseArgs(Deno.args, parseOptions);
  await checkOptions(options);

  const command = options.command ?? COMMANDS.ebooks;
  if (command === COMMANDS.completions) {
    let detectedShell = options._?.[1]?.toString();
    if (!detectedShell) {
      try {
        detectedShell = Deno.env.get("SHELL")?.split("/").pop();
      } catch {
        // Ignore if --allow-env is not granted
      }
    }
    Deno.stdout.writeSync(
      new TextEncoder().encode(generateShellCompletion(detectedShell)),
    );
    Deno.exit(0);
  }

  const behavior = COMMAND_BEHAVIOR[command] ?? {};

  // Initialize the queues (respect low --parallel values like --parallel 1)
  const queues = {
    fileCheck: newQueue(options.parallel),
    orderInfo: newQueue(Math.max(1, Math.min(options.parallel, 5))),
    downloads: newQueue(options.parallel),
  };

  const totals: Totals = {
    bundles: 0,
    checksums: 0,
    checksumsLoaded: 0,
    hashErrors: 0,
    movedFiles: 0,
    linkedFiles: 0,
    preFilteredDownloads: 0,
    filteredDownloads: 0,
    removedFiles: 0,
    removedChecksums: 0,
    downloads: 0,
    doneDownloads: 0,
    failedDownloads: [],
  };

  // Setup progress bar and file logger
  const resolvedLogFile = options.logFile
    ? resolve(options.logFile)
    : resolve(options.downloadFolder, logFileName);

  const progress = new MultiBarWrapper({
    verbose: Boolean(options.verbose),
    logFilePath: resolvedLogFile,
    quietTerminal: Boolean(options.json),
  });

  // Load checksum cache when needed by the command
  const checksums: Record<string, Checksums> = behavior.skipChecksumLoad
    ? {}
    : await loadChecksumCache(options, progress);
  totals.checksumsLoaded = Object.keys(checksums).length;

  const canSaveChecksumCache = !options.dryRun && !behavior.skipChecksumSave;

  // Handle process signals with two-stage SIGINT/SIGTERM support
  const abortController = new AbortController();
  const signal = abortController.signal;
  let shuttingDown = false;

  const shutdown = () => {
    if (shuttingDown) {
      Deno.exit(130);
    }
    shuttingDown = true;
    abortController.abort();

    for (const queue of Object.values(queues)) {
      try {
        queue.clear();
      } catch (_err) {
        // Ignore errors when clearing queues during shutdown
      }
    }

    cleanupActivePartFilesSync();
    if (canSaveChecksumCache && isChecksumCacheDirty(checksums)) {
      try {
        writeJsonFileSync(options.downloadFolder, cacheFileName, checksums);
      } catch {
        // Ignore emergency shutdown write errors
      }
    }
    progress.stop();
    printRunSummary(totals, Boolean(options.json));
    Deno.exit(130);
  };

  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);

  let filteredBundles: DownloadInfo[] = [];
  let allBundles: Bundle[] = [];

  if (command === COMMANDS.cleanupTrash) {
    const removed = await pruneTrash(
      options.downloadFolder,
      options.trashMaxAge,
      Boolean(options.dryRun),
      progress,
    );
    totals.removedFiles += removed;
    progress.log(
      `${
        options.dryRun ? "[Dry Run] Would remove" : "Removed"
      } ${removed} file(s) from .trash`,
    );
  } else if (command === COMMANDS.checksums) {
    progress.log(
      `Calculating checksums of all files in ${options.downloadFolder}`,
    );
    const checksumProgress = progress.create(0, 0, { file: "File Hash Queue" });
    const maybeFlushChecksums = createChecksumFlusher(options, checksums);

    const processFile = (file: WalkEntry) => {
      checksumProgress.setTotal(checksumProgress.getTotal() + 1);
      queues.fileCheck.add(async () => {
        const cacheKey = getChecksumCacheKey(
          file.path,
          file.name,
          options.downloadFolder,
        );
        const existing = checksums[cacheKey] ?? checksums[file.name];
        const st = await Deno.stat(file.path);
        if (
          !options.update &&
          existing?.sha1 &&
          existing?.md5 &&
          (existing.verifiedSize === undefined ||
            existing.verifiedSize === st.size)
        ) {
          if (cacheKey !== file.name && !checksums[cacheKey]) {
            checksums[cacheKey] = existing;
          }
          checksumProgress.increment();
          return;
        }

        const computed = await checksum(file.path, progress, st.size);
        checksums[cacheKey] = {
          ...existing,
          ...computed,
          verifiedSize: st.size,
          verifiedMtime: st.mtime?.getTime(),
        };
        totals.checksums++;
        await maybeFlushChecksums();
        checksumProgress.increment();
      });
    };

    for await (const file of walkExistingFiles(options)) {
      processFile(file);
    }

    if (options.prune) {
      await queues.fileCheck.done();
      const pruned = await pruneMissingChecksums(
        checksums,
        options.downloadFolder,
        Boolean(options.dryRun),
        progress,
      );
      totals.removedChecksums += pruned;
      progress.log(
        `${
          options.dryRun ? "[Dry Run] Would prune" : "Pruned"
        } ${pruned} stale checksum entry(ies)`,
      );
    }
  } else {
    if (command === COMMANDS.trove || command === COMMANDS.cleanupTrove) {
      const previousTroves = !options.dryRun
        ? await readJsonFile<Trove[]>(options.downloadFolder, "troves.json")
        : undefined;
      const troves = await getAllTroves(options);
      if (!options.dryRun) {
        if (Array.isArray(previousTroves) && previousTroves.length > 0) {
          const activeNames = new Set(troves.map((t) => t.machine_name));
          const retired = previousTroves.filter(
            (t) => !activeNames.has(t.machine_name),
          );
          if (retired.length > 0) {
            const existingArchive = await readJsonFile<Trove[]>(
              options.downloadFolder,
              "troves.archive.json",
            );
            const archiveMap = new Map<string, Trove>();
            if (Array.isArray(existingArchive)) {
              for (const item of existingArchive) {
                archiveMap.set(item.machine_name, item);
              }
            }
            for (const item of retired) {
              archiveMap.set(item.machine_name, item);
            }
            await writeJsonFile(
              options.downloadFolder,
              "troves.archive.json",
              Array.from(archiveMap.values()),
            );
          }
        }
        await writeJsonFile(options.downloadFolder, "troves.json", troves);
      }
      filteredBundles = filterTroves(
        troves,
        options,
        totals,
        progress,
      );
    } else {
      const previousBundlesForDiff = options.diff
        ? ((await readJsonFile<Bundle[]>(
          options.downloadFolder,
          "bundles.json",
        )) ?? [])
        : [];
      allBundles = await getAllBundles(options, totals, queues, progress);
      if (command !== COMMANDS.unclaimed) {
        if (command === COMMANDS.ebooks || command === COMMANDS.cleanupEbooks) {
          filteredBundles = filterEbooks(allBundles, options, totals, progress);
        } else if (
          command === COMMANDS.audio ||
          command === COMMANDS.cleanupAudio
        ) {
          filteredBundles = filterAudio(allBundles, options, totals, progress);
        } else if (
          command === COMMANDS.videos ||
          command === COMMANDS.cleanupVideos
        ) {
          filteredBundles = filterVideos(allBundles, options, totals, progress);
        } else {
          filteredBundles = filterBundles(
            allBundles,
            options,
            totals,
            progress,
          );
        }
        if (options.diff) {
          await computeAndPrintDiff(
            previousBundlesForDiff,
            allBundles,
            filteredBundles,
            checksums,
            options,
            progress,
          );
        }
      }
    }

    if (command === COMMANDS.export) {
      await exportCatalog(filteredBundles, options.downloadFolder);
      progress.log(
        `Exported ${filteredBundles.length} items to catalog.json and catalog.csv in ${options.downloadFolder}`,
      );
    } else if (command === COMMANDS.stats || command === COMMANDS.list) {
      progress.stop();
      await printLibraryStats(
        filteredBundles,
        checksums,
        options.downloadFolder,
        totals.bundles,
        Boolean(options.json),
      );
    } else if (command === COMMANDS.bundles) {
      progress.stop();
      await printBundlesList(
        allBundles,
        filteredBundles,
        checksums,
        options.downloadFolder,
        Boolean(options.json),
        options,
      );
    } else if (command === COMMANDS.unclaimed) {
      progress.stop();
      printUnclaimedReport(allBundles, Boolean(options.json), options);
    } else if (command === COMMANDS.verify || command === COMMANDS.repair) {
      verifyItems(
        filteredBundles,
        progress,
        checksums,
        queues,
        totals,
        signal,
        options,
        command === COMMANDS.repair,
      );
    } else if (!behavior.cleanupOnly) {
      downloadItems(
        filteredBundles,
        progress,
        checksums,
        queues,
        totals,
        signal,
        options,
      );
    }
  }

  // Wait for queues sequentially: fileCheck enqueues tasks into downloads,
  // so fileCheck must drain completely before awaiting downloads.done()
  await queues.orderInfo.done();
  await queues.fileCheck.done();
  await queues.downloads.done();

  if (!behavior.printsJsonDirectly) {
    progress.stop();
  }

  if (!behavior.readOnly) {
    if (options.playlists) {
      const generated = await generateAudioPlaylists(
        filteredBundles,
        Boolean(options.dryRun),
      );
      if (generated.length > 0) {
        progress.log(
          `${
            options.dryRun ? "[Dry Run] Would generate" : "Generated"
          } ${generated.length} M3U8 playlist(s)`,
        );
      }
    }
    if (options.externalLinks && allBundles.length > 0) {
      const linkCount = await writeExternalLinkSidecars(
        allBundles,
        options,
        progress,
      );
      if (linkCount > 0) {
        progress.log(
          `${
            options.dryRun ? "[Dry Run] Would write" : "Wrote"
          } ${linkCount} external link (.url) sidecar(s)`,
        );
      }
    }
    if (!options.dryRun) {
      await writeJsonFile(
        options.downloadFolder,
        "filteredBundles.json",
        filteredBundles,
      );
    }
    // Preserve archived Trove/Vault titles that Humble rotated out of the active Vault unless `cleanuptrove` was explicitly requested
    if (command !== COMMANDS.trove) {
      await clean(
        filteredBundles,
        checksums,
        options,
        totals,
        progress,
        getActivePartFiles(),
      );
    }
  }

  if (canSaveChecksumCache) {
    if (isChecksumCacheDirty(checksums)) {
      await writeJsonFile(options.downloadFolder, cacheFileName, checksums);
    }

    if (command !== COMMANDS.verify && command !== COMMANDS.repair) {
      // Clean up empty folders
      await deleteEmptyFolders(options.downloadFolder);
    }
  }

  if (
    options.webhook &&
    !options.dryRun &&
    (!behavior.readOnly || command === COMMANDS.repair)
  ) {
    await sendCompletionWebhook(options.webhook, command, totals, progress);
  }

  const alreadyPrintedJson = Boolean(
    options.json && behavior.printsJsonDirectly,
  );

  if (!alreadyPrintedJson) {
    printRunSummary(totals, Boolean(options.json));
  }

  if ((totals.failedDownloads?.length ?? 0) > 0) {
    Deno.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
