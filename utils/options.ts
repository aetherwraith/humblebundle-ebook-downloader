import { green, red } from "@std/fmt/colors";
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

import { Options } from "../types/general.ts";
import { Platform } from "../types/bundle.ts";
import { TrovePlatform } from "../types/trove.ts";

/**
 * Check and process options
 */
export async function checkOptions(options: Options): Promise<void> {
  validateInitialOptions(options);

  // If auth token is a file path, read it
  if (options.authToken) {
    try {
      const tokenPath = resolve(sanitizeFilename(options.authToken));
      const tokenInfo = await Deno.stat(tokenPath);

      if (tokenInfo.isFile) {
        options.authToken = (
          await Deno.readTextFile(tokenPath)
        ).replace("\n", "");
      }
    } catch (_) {
      // Not a file path, use as-is
    }
  }

  const savedOptions = await readJsonFile(
    options.downloadFolder,
    optionsFileName,
  );
  const optionsToSave: Options = initializeOptionsToSave();
  processOptions(options, savedOptions, optionsToSave);
  await writeJsonFile(options.downloadFolder, optionsFileName, optionsToSave);
}

/**
 * Validate initial options and set defaults
 */
function validateInitialOptions(options: Options): void {
  if (
    options._?.length !== 1 ||
    !Object.values(COMMANDS).includes(options._[0].toLowerCase())
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

/**
 * Initialize options object with default values
 */
function initializeOptionsToSave(): Options {
  return {
    dedup: false,
    bundleFolders: false,
    productFolders: false,
    humanFileNames: false,
    parallel: 0,
    format: [],
    platform: [],
    authToken: "",
    downloadFolder: "",
  };
}

/**
 * Process options and check for validity
 */
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
        if (options.command === COMMANDS.trove) {
          checkArrayOption(options[key], Object.values(TrovePlatform));
        } else {
          checkArrayOption(options[key], Object.values(Platform));
        }
        break;
    }
    if (!argNoSave.includes(key)) {
      handleOptionDifferences(key, options, savedOptions, optionsToSave);
    }
  }
}

/**
 * Handle differences between saved options and current options
 */
function handleOptionDifferences(
  key: string,
  options: Options,
  savedOptions: Options,
  optionsToSave: Options,
): void {
  optionsToSave[key] = options[key];

  if (
    Object.hasOwn(savedOptions, key) &&
    JSON.stringify(savedOptions[key]) !== JSON.stringify(options[key])
  ) {
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

/**
 * Prompt user when option differs from saved value
 */
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

/**
 * Display error and usage information, then exit
 */
function optionError(message: string): never {
  console.error(message);
  usage();
  Deno.exit(1);
}

/**
 * Check if all array values are valid
 */
function checkArrayOption(values: string[], validValues: string[]): void {
  if (!values.every((value) => validValues.includes(value))) {
    optionError(
      `${values} contains one or more invalid values. Supported values are ${
        validValues.join(
          ",",
        )
      }`,
    );
  }
}

/**
 * Display usage information
 */
function usage(): void {
  console.log(
    "To download your humble bundle artifacts please use the following parameters",
  );
  console.log(
    `Specify a command as one of ${Object.values(COMMANDS).join(",")}`,
  );
  for (const [key, value] of Object.entries(argDescriptions)) {
    if (argRequired.includes(key)) {
      console.log(`${red("(Required)")} ${red(key)} : ${value}`);
    } else {
      console.log(`${green("(Optional)")} ${green(key)} : ${value}`);
    }
  }
}
