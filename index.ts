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
import { filterBundles } from "./utils/orders.ts";
import { Options, Totals } from "./utils/types.ts";

// Parse and check options
const options: Options = parseArgs(Deno.args, parseOptions);
await checkOptions(options);

// Initialize the queues
const queues = {
  fileCheckQueue: newQueue(options.parallel),
  orderInfoQueue: newQueue(options.parallel),
};

const totals: Totals = {
  bundles: 0,
  checksums: 0,
  checksumsLoaded: 0,
  preFilteredDownloads: 0,
  filteredDownloads: 0,
  removedFiles: 0,
  removedChecksums: 0,
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
const checksums = await loadChecksumCache(options);
totals.checksumsLoaded = Object.keys(checksums).length;

// Handle process signals
process.on("SIGINT", () => {
  for (const queue of Object.values(queues)) {
    queue.clear();
  }
});

// Main switch case for command execution
switch (options.command) {
  case COMMANDS.checksums: {
    log.info(`Calculating checksums of all files in ${options.downloadFolder}`);

    const checksumBars = new Set();
    const checksumProgress = progress.create(0, 0, { file: "File Hash Queue" });

    const processFile = (file: WalkEntry) => {
      if (checksumBars.has(file.name)) {
        log.error(`Duplicate file name: ${file.name}`);
        Deno.exit(1);
      }
      checksumProgress.setTotal(checksumProgress.total + 1);

      queues.fileCheckQueue.add(async () => {
        checksums[file.name] = await checksum(file, progress, checksumBars);
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
}

// Wait for queues to complete
await Promise.all(Object.values(queues).map((queue) => queue.done()));
progress.stop();

log.info(totals);
