import {
  argDescriptions,
  argNoSave,
  argRequired,
  COMMANDS,
  optionsFileName,
  SUPPORTED_FORMATS,
  SUPPORTED_PLATFORMS,
} from "./constants.ts";
import { readJsonFile, writeJsonFile } from "./fileUtils.ts";
import * as log from "@std/log";
import { green, red } from "@std/fmt/colors";
import { isEql } from "@opentf/std";
import { includesValue } from "@std/collections/includes-value";

export async function checkOptions(options) {
  if (
    options._.length !== 1 ||
    !includesValue(COMMANDS, options._[0].toLowerCase())
  ) {
    optionError("No or invalid command!");
  } else if (!options.downloadFolder) {
    optionError("Please specify download folder (--download-folder or -d)");
  } else if (options._[0] !== COMMANDS.checksums && !options.authToken) {
    optionError("Please specify auth token  (--auth-token or -t)");
  }

  const savedOptions = await readJsonFile(
    options.downloadFolder,
    optionsFileName,
  );
  const saveMe = {};
  for (const key of Object.keys(argDescriptions)) {
    switch (key) {
      case "format":
        checkArrayOption(options[key], SUPPORTED_FORMATS);
        break;
      case "platform":
        checkArrayOption(options[key], SUPPORTED_PLATFORMS);
        break;
      case "authToken":
        break;
    }
    if (!argNoSave.includes(key)) {
      saveMe[key] = options[key];
      if (savedOptions[key] && !isEql(savedOptions[key], options[key])) {
        const useNewValue = prompt(
          `${key} differs from saved.\n\toriginal: ${savedOptions[key]}\n\tnew: ${
            options[key]
          }\nUse new value (Y/n)?`,
          "Y",
        );
        if (!useNewValue?.toLowerCase()?.includes("y")) {
          options[key] = savedOptions[key];
          saveMe[key] = savedOptions[key];
        }
      }
    }
  }

  await writeJsonFile(options.downloadFolder, optionsFileName, saveMe);
  options.command = options._[0];
}

function usage() {
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

function optionError(message: string) {
  log.error(message);
  usage();
  Deno.exit(1);
}

function checkArrayOption(values: string[], validValues: string[]) {
  if (!values.every((value) => validValues.includes(value))) {
    optionError(
      `${values} contains one or more invalid formats. Supported formats are ${validValues.join(
        ",",
      )}`,
    );
  }
}
