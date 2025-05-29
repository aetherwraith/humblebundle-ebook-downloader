import { parseArgs } from "@std/cli/parse-args";
import { WalkEntry } from "@std/fs/walk";
import { checksum } from "./utils/checksums.ts";
import { COMMANDS, parseOptions } from "./utils/constants.ts";
import { downloadItems } from "./utils/download.ts";
import {
  clean,
  loadChecksumCache,
  walkExistingFiles,
  writeJsonFile,
} from "./utils/fileUtils.ts";
import {
  startConnectivityMonitoring,
  stopConnectivityMonitoring,
} from "./utils/network.ts";
import { checkOptions } from "./utils/options.ts";
import { filterBundles, filterEbooks } from "./utils/orders.ts";
import { MultiBar, ShadesClassicPreset } from "./utils/progress.ts";
import { newQueue } from "./utils/queue.ts";

import { getAllBundles, getAllTroves } from "./utils/web.ts";
import { DownloadInfo, Options, Totals } from "./types/general.ts";
import { Checksums } from "./types/bundle.ts";
import { filterTroves } from "./utils/troves.ts";

/**
 * Main entry point
 */
async function main() {
  // Parse and check options
  const options: Options = parseArgs(Deno.args, parseOptions) as Options;
  await checkOptions(options);

  // Initialize the queues with optimized concurrency settings
  const defaultParallel = navigator.hardwareConcurrency || 4;
  const queues = {
    fileCheck: newQueue(options.parallel || defaultParallel),
    orderInfo: newQueue(options.parallel || Math.min(8, defaultParallel)),
    downloads: newQueue(options.parallel || Math.min(6, defaultParallel)),
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
  const progress = new MultiBar({
    ...ShadesClassicPreset,
    autopadding: true,
  });

  // Add a blank line to start progress display
  console.log("");

  // Start network connectivity monitoring
  startConnectivityMonitoring(progress);

  // Load checksum cache
  const checksums: Record<string, Checksums> = await loadChecksumCache(options);
  totals.checksumsLoaded = Object.keys(checksums).length;

  // Handle process signals
  Deno.addSignalListener("SIGINT", () => {
    for (const queue of Object.values(queues)) {
      queue.clear();
    }
    progress.stop();
  });

  let filteredBundles: DownloadInfo[] = [];

  // Main switch case for command execution
  switch (options.command?.toLowerCase()) {
    case COMMANDS.checksums: {
      progress.log(
        `Calculating checksums of all files in ${options.downloadFolder}`,
      );

      const checksumProgress = progress.create(0, 0, {
        file: "File Hash Queue",
      });

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
      filteredBundles = filterBundles(bundles, options, totals, progress);
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
      downloadItems(filteredBundles, progress, checksums, queues, totals);
      break;
    }
    case COMMANDS.all: {
      console.log("Downloading all bundles...");
      const bundles = await getAllBundles(options, totals, queues, progress);
      filteredBundles = filterBundles(bundles, options, totals, progress);
      downloadItems(filteredBundles, progress, checksums, queues, totals);
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
      downloadItems(filteredBundles, progress, checksums, queues, totals);
      break;
    }
  }

  // Wait for queues to complete
  await Promise.all(Object.values(queues).map((queue) => queue.done()));
  progress.stop();
  await clean(filteredBundles, checksums, options, totals);

  // Stop network monitoring before exit
  stopConnectivityMonitoring();

  console.log("Execution completed with the following statistics:");
  console.log(totals);
}

// Run the main function
main().catch((err) => {
  console.error("Error:", err);
  Deno.exit(1);
});
