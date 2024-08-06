#!/usr/bin/env -S deno run --allow-env

import { parseArgs } from "@std/cli/parse-args";
import * as log from "@std/log";
import { COMMANDS, parseOptions } from "./utils/constants.ts";
import { checkOptions } from "./utils/optionsUtils.ts";

const options = parseArgs(Deno.args, parseOptions);

await checkOptions(options);

switch (options.command) {
  case COMMANDS.checksums:
    log.info(`Calculating checksums of all files in ${options.downloadFolder}`);
    break;
}
