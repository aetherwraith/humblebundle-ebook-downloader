import { newQueue } from "@henrygd/queue";
import { parseArgs } from "@std/cli/parse-args";
import { WalkEntry } from "@std/fs/walk";
import * as log from "@std/log";

import { MultiBarWrapper } from "./utils/progressWrapper.ts";
import { checksum } from "./utils/checksums.ts";
import { COMMANDS, parseOptions } from "./utils/constants.ts";
import { downloadItems } from "./utils/download.ts";
import {
  clean,
  deleteEmptyFolders,
  loadChecksumCache,
  walkExistingFiles,
  writeJsonFile,
} from "./utils/fileUtils.ts";
import { checkOptions } from "./utils/options.ts";
import { filterBundles, filterEbooks } from "./utils/orders.ts";

import { getAllBundles, getAllTroves } from "./utils/web.ts";
import { DownloadInfo, Options, Totals } from "./types/general.ts";
import { Checksums } from "./types/bundle.ts";
import { filterTroves } from "./utils/troves.ts";

// Parse and check options
const options: Options = parseArgs(Deno.args, parseOptions);
await checkOptions(options);

// Initialize the queues
const queues = {
  fileCheck: newQueue(options.parallel),
  orderInfo: newQueue(options.parallel),
  downloads: newQueue(options.parallel),
};

const totals: Totals = {
  bundles: 0,
  checksums: 0,
  checksumsLoaded: 0,
  preFilteredDownloads: 0,
  filteredDownloads: 0,
  removedFiles: 0,
  removedChecksums: 0,
  downloads: 0,
  doneDownloads: 0,
};

// Setup progress bar
const progress = new MultiBarWrapper(
  {
    clearOnComplete: true,
    format:
      ' {bar} | {percentage}% | {duration_formatted}/{eta_formatted} | {value}/{total} | "{file}" ',
    hideCursor: true,
    etaBuffer: 25000,
    etaAsynchronousUpdate: true,
    autopadding: true,
  },
);

// Load checksum cache
const checksums: Record<string, Checksums> = await loadChecksumCache(options);
totals.checksumsLoaded = Object.keys(checksums).length;

// Handle process signals
const abortController = new AbortController();
const signal = abortController.signal;

Deno.addSignalListener("SIGINT", () => {
  abortController.abort();

  for (const queue of Object.values(queues)) {
    try {
      queue.clear();
    } catch (_err) {
      // Ignore errors when clearing queues during shutdown
    }
  }

  progress.stop();
  log.info(totals);
  Deno.exit(0);
});

let filteredBundles: DownloadInfo[] = [];

// Main switch case for command execution
switch (options.command?.toLowerCase()) {
  case COMMANDS.checksums: {
    progress.log(
      `Calculating checksums of all files in ${options.downloadFolder}`,
    );

    const checksumProgress = progress.create(0, 0, { file: "File Hash Queue" });

    const processFile = (file: WalkEntry) => {
      checksumProgress.setTotal(checksumProgress.getTotal() + 1);

      queues.fileCheck.add(async () => {
        checksums[file.name] = await checksum(file.path, progress);
        totals.checksums++;
        checksumProgress.increment();
      });
    };

    for await (const file of walkExistingFiles(options)) {
      processFile(file);
    }
    break;
  }
  case COMMANDS.cleanup: {
    const bundles = await getAllBundles(options, totals, queues, progress);
    filteredBundles = await filterBundles(bundles, options, totals, progress);
    break;
  }
  case COMMANDS.cleanupEbooks: {
    const bundles = await getAllBundles(options, totals, queues, progress);
    filteredBundles = filterEbooks(bundles, options, totals, progress);
    break;
  }
  case COMMANDS.ebooks: {
    const bundles = await getAllBundles(options, totals, queues, progress);
    filteredBundles = filterEbooks(bundles, options, totals, progress);
    downloadItems(filteredBundles, progress, checksums, queues, totals, signal, options);
    break;
  }
  case COMMANDS.all: {
    const bundles = await getAllBundles(options, totals, queues, progress);
    filteredBundles = await filterBundles(bundles, options, totals, progress);
    downloadItems(filteredBundles, progress, checksums, queues, totals, signal, options);
    break;
  }
  case COMMANDS.trove: {
    const troves = await getAllTroves(options);
    await writeJsonFile(options.downloadFolder, "troves.json", troves);
    filteredBundles = await filterTroves(
      troves,
      options,
      totals,
      progress,
      queues,
    );
    downloadItems(filteredBundles, progress, checksums, queues, totals, signal, options);
  }
}

// Wait for queues to complete
await writeJsonFile(
  options.downloadFolder,
  "filteredBundles.json",
  filteredBundles,
);
await Promise.all(Object.values(queues).map((queue) => queue.done()));
progress.stop();
await clean(filteredBundles, checksums, options, totals);

// Clean up empty folders
await deleteEmptyFolders(options.downloadFolder);

log.info(totals);
