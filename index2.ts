#!/usr/bin/env -S deno run --allow-env

import { parseArgs } from "@std/cli/parse-args";
import * as log from "@std/log";
import { COMMANDS, parseOptions } from "./utils/constants.ts";
import { checkOptions } from "./utils/optionsUtils.ts";
import { walk } from "@std/fs/walk";
import { loadChecksumCache } from "./utils/fileUtils.ts";
import { newQueue } from "@henrygd/queue";
import { checksum } from "./checksums.ts";
import { MultiProgressBar } from "@deno-library/progress";

const options = parseArgs(Deno.args, parseOptions);

await checkOptions(options);
const fileCheckQueue = newQueue(options.parallel);

switch (options.command) {
  case COMMANDS.checksums: {
    log.info(`Calculating checksums of all files in ${options.downloadFolder}`);
    const checksumProgress = new MultiProgressBar({
      title: "Checksumming...",
      prettyTime: true,
      clear: true,
    });
    const checksumBars = {};
    const checksums = await loadChecksumCache(options);
    for await (
      const file of walk(options.downloadFolder, {
        includeDirs: false,
        includeSymlinks: false,
        skip: [/json/],
      })
    ) {
      if (file.name.includes("json")) log.error("Json file!!!!");
      checksums[file.name] = await fileCheckQueue.add(() =>
        checksum(file, checksumProgress, checksumBars)
      );
    }
    break;
  }
}

await fileCheckQueue.done();
