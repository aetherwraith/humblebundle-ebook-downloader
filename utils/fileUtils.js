import { resolve } from 'node:path';
import sanitizeFilename from 'sanitize-filename';
import { readFile, writeFile } from 'node:fs/promises';
import { mkdirp } from 'mkdirp';
import { cacheFileName } from './constants.js';
import process from 'node:process';
import colors from 'colors';

export async function readJsonFile(folder, file) {
  const filePath = resolve(folder, sanitizeFilename(file));

  const contents = await readFile(filePath, { encoding: 'utf8' }).catch(_ => {
    return '{}';
  });

  return JSON.parse(contents);
}

export async function writeJsonFile(folder, file, contents) {
  const filePath = resolve(folder, sanitizeFilename(file));
  await mkdirp(folder);
  return writeFile(filePath, JSON.stringify(contents));
}

export async function loadChecksumCache(options) {
  // load cache file of checksums

  const checksumCache = await readJsonFile(
    options.downloadFolder,
    cacheFileName
  );

  process.on('beforeExit', async code => {
    await writeJsonFile(options.downloadFolder, cacheFileName, checksumCache);
    process.exit(code);
  });

  console.log(
    `${colors.green(Object.keys(checksumCache).length)} checksums loaded`
  );
  return checksumCache;
}
