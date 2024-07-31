#!/usr/bin/env -S deno run --allow-env

import { parseArgs } from "@std/cli/parse-args";
import * as log from "@std/log";
import { parseOptions } from "./utils/constants.ts";
import { checkOptions } from "./utils/optionsUtils.ts";

const options = parseArgs(Deno.args, parseOptions);
log.info(options);

await checkOptions(options);
