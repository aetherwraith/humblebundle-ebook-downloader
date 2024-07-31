import {
  argDescriptions,
  argNoSave,
  argRequired,
  optionsFileName,
} from "./constants.ts";
import { readJsonFile, writeJsonFile } from "./fileUtils.ts";
import * as log from "@std/log";
import { green, red } from "@std/fmt/colors";
import { isEql, isEqlArr } from "@opentf/std";

export async function checkOptions(options) {
  if (!options.downloadFolder) {
    missingOption("Please specify download folder (--download-folder or -d)");
  } else if (!options.authToken) {
    missingOption("Please specify auth token  (--auth-token or -t)");
  }

  const savedOptions = await readJsonFile(
    options.downloadFolder,
    optionsFileName,
  );
  const saveMe = {};
  for (const key of Object.keys(argDescriptions)) {
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
}

function usage() {
  log.info(
    "To download your humble bundle artifacts please use the following parameters",
  );
  for (const [key, value] of Object.entries(argDescriptions)) {
    if (argRequired.includes(key)) {
      log.info(`${red("(Required)")} ${red(key)} : ${value}`);
    } else {
      log.info(`${green("(Optional)")} ${green(key)} : ${value}`);
    }
  }
}

function missingOption(message: string) {
  log.error(message);
  usage();
  Deno.exit(1);
}
