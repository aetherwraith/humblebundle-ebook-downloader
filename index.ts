#!/usr/bin/env -S deno run --allow-env
/// <reference types="npm:@types/node" />
/// <reference types="npm:@types/cli-progress" />

import { parseArgs } from "@std/cli/parse-args";
import * as log from "@std/log";
import { COMMANDS, parseOptions } from "./utils/constants.ts";
import { checkOptions } from "./utils/optionsUtils.ts";
import { WalkEntry } from "@std/fs/walk";
import {
  clean,
  loadChecksumCache,
  walkExistingFiles,
} from "./utils/fileUtils.ts";
import { newQueue } from "@henrygd/queue";
import { checksum } from "./utils/checksums.ts";
import cliProgress from "cli-progress";
import process from "node:process";
import { getAllBundles } from "./utils/web.ts";
import { filterBundles, filterEbooks } from "./utils/orders.ts";
import {Checksums, Options, Totals} from "./utils/types.ts";
import {downloadItem} from "./utils/download.ts";

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
const progress = new cliProgress.MultiBar(
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
});

// Main switch case for command execution
switch (options.command?.toLowerCase()) {
  case COMMANDS.checksums: {
    log.info(`Calculating checksums of all files in ${options.downloadFolder}`);

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
    const filteredBundles = filterBundles(bundles, options, totals);
    await clean(filteredBundles, checksums, options, totals);
    break;
  }
  case COMMANDS.cleanupEbooks: {
    const bundles = await getAllBundles(options, totals, queues, progress);
    const filteredBundles = filterEbooks(bundles, options, totals);
    await clean(filteredBundles, checksums, options, totals);
    break;
  }
  case COMMANDS.ebooks: {
    const bundles = await getAllBundles(options, totals, queues, progress);
    const filteredBundles = filterEbooks(bundles, options, totals);

    const downloadProgress = progress.create(filteredBundles.length, 0, { file: "Download Queue" });
    await Promise.all(filteredBundles.map(async (download) =>
      downloadItem(download, checksums, progress, downloadProgress, queues, totals)
    ));

    await Promise.all(Object.values(queues).map((queue) => queue.done()));

    await clean(filteredBundles, checksums, options, totals);
    break;
  }
}

// Wait for queues to complete
await Promise.all(Object.values(queues).map((queue) => queue.done()));
progress.stop();

log.info(totals);
