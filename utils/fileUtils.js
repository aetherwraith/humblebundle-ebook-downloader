import { resolve } from 'node:path';
import sanitizeFilename from 'sanitize-filename';
import { readFile, writeFile } from 'node:fs/promises';
import { mkdirp } from 'mkdirp';

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
