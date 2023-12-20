import { InvalidOptionArgumentError } from 'commander';
import { SUPPORTED_FORMATS } from './constants.js';

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
