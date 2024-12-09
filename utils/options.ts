import { isEql } from "@opentf/std";
import { includesValue } from "@std/collections/includes-value";
import { green, red } from "@std/fmt/colors";
import { exists } from "@std/fs/exists";
import * as log from "@std/log";
import { resolve } from "@std/path";
import sanitizeFilename from "sanitize-filename";
import {
  argDescriptions,
  argNoSave,
  argRequired,
  COMMANDS,
  INVALID_COMMAND_ERROR,
  MISSING_AUTH_TOKEN_ERROR,
  MISSING_DOWNLOAD_FOLDER_ERROR,
  optionsFileName,
  SUPPORTED_FORMATS,
} from "./constants.ts";
import { readJsonFile, writeJsonFile } from "./fileUtils.ts";
import { Options, Platform } from "./types.ts";

export async function checkOptions(options: Options) {
  validateInitialOptions(options);
  if (
    options.authToken &&
    (await exists(resolve(sanitizeFilename(options.authToken))))
  ) {
    options.authToken = (
      await Deno.readTextFile(resolve(sanitizeFilename(options.authToken)))
    ).replace("\n", "");
  }
  const savedOptions = await readJsonFile(
    options.downloadFolder,
    optionsFileName,
  );
  const optionsToSave: Options = initializeOptionsToSave();
  processOptions(options, savedOptions, optionsToSave);
  await writeJsonFile(options.downloadFolder, optionsFileName, optionsToSave);
}

function validateInitialOptions(options: Options): void {
  if (
    options._?.length !== 1 ||
    !includesValue(COMMANDS, options._[0].toLowerCase())
  ) {
    optionError(INVALID_COMMAND_ERROR);
  } else if (!options.downloadFolder) {
    optionError(MISSING_DOWNLOAD_FOLDER_ERROR);
  } else if (options._[0] !== COMMANDS.checksums && !options.authToken) {
    optionError(MISSING_AUTH_TOKEN_ERROR);
  } else {
    options.command = options._[0];
  }
}

function initializeOptionsToSave(): Options {
  return {
    dedup: false,
    bundleFolders: false,
    parallel: 0,
    format: [],
    platform: [],
    authToken: "",
    downloadFolder: "",
  };
}

function processOptions(
  options: Options,
  savedOptions: Options,
  optionsToSave: Options,
): void {
  for (const key of Object.keys(argDescriptions)) {
    switch (key) {
      case "format":
        checkArrayOption(options[key], SUPPORTED_FORMATS);
        break;
      case "platform":
        checkArrayOption(options[key], Object.values(Platform));
        break;
    }
    if (!argNoSave.includes(key)) {
      handleOptionDifferences(key, options, savedOptions, optionsToSave);
    }
  }
}

function handleOptionDifferences(
  key: string,
  options: Options,
  savedOptions: Options,
  optionsToSave: Options,
): void {
  optionsToSave[key] = options[key];
  if (savedOptions[key] && !isEql(savedOptions[key], options[key])) {
    const useNewValue = promptOptionChange(
      key,
      savedOptions[key],
      options[key],
    );
    if (!useNewValue?.toLowerCase()?.includes("y")) {
      options[key] = savedOptions[key];
      optionsToSave[key] = savedOptions[key];
    }
  }
}

function promptOptionChange(
  key: string,
  original: unknown,
  newValue: unknown,
): string | null {
  return prompt(
    `${key} differs from saved.\n\toriginal: ${original}\n\tnew: ${newValue}\nUse new value (y/N)?`,
    "N",
  );
}

function optionError(message: string): void {
  log.error(message);
  usage();
  Deno.exit(1);
}

function checkArrayOption(values: string[], validValues: string[]): void {
  if (!values.every((value) => validValues.includes(value))) {
    optionError(
      `${values} contains one or more invalid formats. Supported formats are ${
        validValues.join(
          ",",
        )
      }`,
    );
  }
}

function usage(): void {
  log.info(
    "To download your humble bundle artifacts please use the following parameters",
  );
  log.info(`Specify a command as one of ${Object.values(COMMANDS).join(",")}`);
  for (const [key, value] of Object.entries(argDescriptions)) {
    if (argRequired.includes(key)) {
      log.info(`${red("(Required)")} ${red(key)} : ${value}`);
    } else {
      log.info(`${green("(Optional)")} ${green(key)} : ${value}`);
    }
  }
}
