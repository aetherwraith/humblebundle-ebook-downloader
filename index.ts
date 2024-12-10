import { newQueue } from "@henrygd/queue";
import { parseArgs } from "@std/cli/parse-args";
import { WalkEntry } from "@std/fs/walk";
import * as log from "@std/log";
import type { MultiBar } from "cli-progress";
import cliProgress from "cli-progress";
import process from "node:process";
import { checksum } from "./utils/checksums.ts";
import { COMMANDS, parseOptions } from "./utils/constants.ts";
import { downloadItems } from "./utils/download.ts";
import {
  clean,
  loadChecksumCache,
  walkExistingFiles,
  writeJsonFile,
} from "./utils/fileUtils.ts";
import { checkOptions } from "./utils/options.ts";
import { DownloadInfo, filterBundles, filterEbooks } from "./utils/orders.ts";
import { Checksums, Options, Totals } from "./utils/types.ts";
import { getAllBundles } from "./utils/web.ts";

// Parse and check options
const options: Options = parseArgs(Deno.args, parseOptions);
await checkOptions(options);

// Initialize the queues
const queues = {
  fileCheck: newQueue(options.parallel),
  orderInfo: newQueue(options.parallel * 2), // multiply by two as it is pretty lightweight
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
const progress: MultiBar = new cliProgress.MultiBar(
  {
    clearOnComplete: true,
    format:
      ' {bar} | {percentage}% | {duration_formatted}/{eta_formatted} | {value}/{total} | "{file}" ',
    hideCursor: true,
    etaBuffer: 25000,
    etaAsynchronousUpdate: true,
    autopadding: true,
  },
  cliProgress.Presets.shades_classic,
);

// Load checksum cache
const checksums: Record<string, Checksums> = await loadChecksumCache(options);
totals.checksumsLoaded = Object.keys(checksums).length;

// Handle process signals
process.on("SIGINT", () => {
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

    const checksumProgress = progress.create(0, 0, { file: "File Hash Queue" });

    const processFile = (file: WalkEntry) => {
      checksumProgress.setTotal(checksumProgress.total + 1);

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
    const bundles = await getAllBundles(options, totals, queues, progress);
    filteredBundles = filterBundles(bundles, options, totals, progress);
    downloadItems(filteredBundles, progress, checksums, queues, totals);
    break;
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

log.info(totals);
