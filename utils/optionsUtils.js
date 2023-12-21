import { InvalidOptionArgumentError } from 'commander';
import { optionsFileName, SUPPORTED_FORMATS } from './constants.js';
import { readJsonFile, writeJsonFile } from './fileUtils.js';
import * as readline from 'node:readline/promises';
import process from 'node:process';

export function parseIntOption(value, dummyPrevious) {
  const parsedValue = parseInt(value, 10);
  if (isNaN(parsedValue)) {
    throw new InvalidOptionArgumentError(`${value} is not a number.`);
  }
  return parsedValue;
}

export function parseArrayOption(value, dummyPrevious) {
  const parsedValue = value.split(',');
  if (!parsedValue.every(format => SUPPORTED_FORMATS.includes(format))) {
    throw new InvalidOptionArgumentError(
      `${value} contains one or more invalid formats. Supported formats are ${SUPPORTED_FORMATS.join(
        ','
      )}`
    );
  }
  return parsedValue;
}

export async function checkOptions(options) {
  const savedOptions = await readJsonFile(
    options.downloadFolder,
    optionsFileName
  );
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  for (const key of Object.keys(savedOptions)) {
    if (savedOptions[key] !== options[key]) {
      const useNewValue = await rl.question(
        `${key} differs from saved.\n\toriginal: ${savedOptions[key]}\n\tnew: ${options[key]}\nUse new value (Y/n)?`
      );
      if (useNewValue.toLowerCase() !== 'y') {
        options[key] = savedOptions[key];
      }
    }
  }
  rl.close();
  const saveMe = { ...options };
  delete saveMe.downloadFolder;
  delete saveMe.authToken;
  await writeJsonFile(options.downloadFolder, optionsFileName, saveMe);
}
