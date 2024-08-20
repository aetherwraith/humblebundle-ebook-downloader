#!/usr/bin/env -S deno run --allow-env

/// <reference types="npm:@types/node" />
/// <reference types="npm:@types/cli-progress" />

import { parseArgs } from "@std/cli/parse-args";
import * as log from "@std/log";
import { COMMANDS, Options, parseOptions } from "./utils/constants.ts";
import { checkOptions } from "./utils/optionsUtils.ts";
import { walk } from "@std/fs/walk";
import { loadChecksumCache } from "./utils/fileUtils.ts";
import { newQueue } from "@henrygd/queue";
import { checksum } from "./checksums.ts";
import cliProgress from "cli-progress";
import process from "node:process";
import { blue, green } from "@std/fmt/colors";

const options: Options = parseArgs(Deno.args, parseOptions);

await checkOptions(options);
const fileCheckQueue = newQueue(options.parallel);

let totalChecksums = 0;

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

const checksums = await loadChecksumCache(options);

process.on("SIGINT", () => {
  fileCheckQueue.clear();
});

switch (options.command) {
  case COMMANDS.checksums: {
    log.info(`Calculating checksums of all files in ${options.downloadFolder}`);

    const checksumBars = new Set();
    checksumBars.checkq = progress.create(0, 0, { file: "File Hash Queue" });
    for await (
      const file of walk(options.downloadFolder, {
        includeDirs: false,
        includeSymlinks: false,
        skip: [/json/],
      })
    ) {
      if (Object.hasOwn(checksumBars, file.name)) {
        log.error(`Duplicate file name: ${file.name}`);
        Deno.exit(1);
      }
      const total = checksumBars.checkq.total;
      checksumBars.checkq.setTotal(total + 1);
      fileCheckQueue.add(async () => {
        checksums[file.name] = await checksum(file, progress, checksumBars);
        totalChecksums++;
        checksumBars.checkq.increment();
      });
    }
    break;
  }
}

await fileCheckQueue.done();

progress.stop();

log.info(`${green("Updated:")} ${blue(totalChecksums.toString())}`);
