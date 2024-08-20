#!/usr/bin/env -S deno run --allow-env
/// <reference types="npm:@types/node" />
/// <reference types="npm:@types/cli-progress" />

import { parseArgs } from "@std/cli/parse-args";
import * as log from "@std/log";
import { COMMANDS, Options, parseOptions } from "./utils/constants.ts";
import { checkOptions } from "./utils/optionsUtils.ts";
import { walk, WalkEntry } from "@std/fs/walk";
import { loadChecksumCache } from "./utils/fileUtils.ts";
import { newQueue } from "@henrygd/queue";
import { checksum } from "./checksums.ts";
import cliProgress from "cli-progress";
import process from "node:process";
import { blue, green } from "@std/fmt/colors";

// Parse and check options
const options: Options = parseArgs(Deno.args, parseOptions);
await checkOptions(options);

// Initialize the file check queue
const fileCheckQueue = newQueue(options.parallel);
let totalChecksums = 0;

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

// Handle process signals
process.on("SIGINT", () => {
  fileCheckQueue.clear();
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
      fileCheckQueue.add(async () => {
        checksums[file.name] = await checksum(file, progress, checksumBars);
        totalChecksums++;
        checksumProgress.increment();
      });
    };

    for await (
      const file of walk(options.downloadFolder, {
        includeDirs: false,
        includeSymlinks: false,
        skip: [/json/],
      })
    ) {
      processFile(file);
    }
    break;
  }
}

// Wait for queue to complete
await fileCheckQueue.done();
progress.stop();

log.info(`${green("Updated:")} ${blue(totalChecksums.toString())}`);
