#!/usr/bin/env -S deno run --allow-env
/// <reference types="npm:@types/node" />
/// <reference types="npm:@types/cli-progress" />

import { parseArgs } from "@std/cli/parse-args";
import * as log from "@std/log";
import { COMMANDS, Options, parseOptions } from "./utils/constants.ts";
import { checkOptions } from "./utils/optionsUtils.ts";
import { walk, WalkEntry } from "@std/fs/walk";
import { loadChecksumCache, writeJsonFile } from "./utils/fileUtils.ts";
import { newQueue } from "@henrygd/queue";
import { checksum } from "./checksums.ts";
import cliProgress from "cli-progress";
import process from "node:process";
import { green, yellow } from "@std/fmt/colors";
import { getRequestHeaders } from "./utils/web.ts";

// Parse and check options
const options: Options = parseArgs(Deno.args, parseOptions);
await checkOptions(options);

// Initialize the queues
const fileCheckQueue = newQueue(options.parallel);
const orderInfoQueue = newQueue(options.parallel);
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
      log.info(file);
      processFile(file);
    }
    break;
  }
  case COMMANDS.cleanup: {
    const base = "https://www.humblebundle.com";
    const orderPath = "/api/v1/user/order?ajax=true";
    const orderResponse = await fetch(base + orderPath, {
      headers: getRequestHeaders(options),
    });
    const gameKeys = await orderResponse.json();
    log.info(`Fetching order information for ${gameKeys.length} bundles`);
    const bundlesBar = progress.create(gameKeys.length, 0, { file: "Bundles" });
    const bundles = [];
    for (const gameKey of gameKeys) {
      orderInfoQueue.add(async () => {
        bundles.push(
          await fetch(base + `/api/v1/order/${gameKey.gamekey}?ajax=true`, {
            headers: getRequestHeaders(options),
          }).then(async (response) => await response.json()),
        );
        bundlesBar.increment();
      });
    }
    await orderInfoQueue.done();
    progress.remove(bundlesBar);
    log.info(
      bundles.toSorted((a, b) =>
        a.product.human_name.localeCompare(b.product.human_name)
      ),
    );
    await writeJsonFile(
      ".",
      "bundles.json",
      bundles.toSorted((a, b) =>
        a.product.human_name.localeCompare(b.product.human_name)
      ),
    );
    break;
  }
}

// Wait for queues to complete
await fileCheckQueue.done();
progress.stop();

log.info(`${green("Updated checksums:")} ${yellow(totalChecksums.toString())}`);
