import { resolve } from "@std/path";
import sanitizeFilename from "sanitize-filename";
import process from "node:process";
import { cacheFileName, Options } from "./constants.ts";
import * as log from "@std/log";
import { green } from "@std/fmt/colors";
import { Checksums } from "./types.ts";

export async function readJsonFile(folder: string, file: string) {
  const filePath = resolve(folder, sanitizeFilename(file));

  const contents = await Deno.readTextFile(filePath).catch((_) => {
    return "{}";
  });

  return JSON.parse(contents);
}

export async function writeJsonFile(
  folder: string,
  file: string,
  contents: object,
) {
  const filePath = resolve(folder, sanitizeFilename(file));
  await Deno.mkdir(folder, { recursive: true });
  return Deno.writeTextFile(filePath, JSON.stringify(contents));
}

export function writeJsonFileSync(
  folder: string,
  file: string,
  contents: object,
) {
  const filePath = resolve(folder, sanitizeFilename(file));
  Deno.mkdirSync(folder, { recursive: true });
  Deno.writeTextFileSync(filePath, JSON.stringify(contents));
}

export async function loadChecksumCache(options: Options) {
  // load cache file of checksums

  const checksumCache = await readJsonFile(
    options.downloadFolder,
    cacheFileName,
  );

  process.on("SIGINT", () => {
    writeJsonFileSync(options.downloadFolder, cacheFileName, checksumCache);
  });

  process.on("exit", () => {
    writeJsonFileSync(options.downloadFolder, cacheFileName, checksumCache);
  });

  log.info(
    `${green(Object.keys(checksumCache).length.toString())} checksums loaded`,
  );
  return checksumCache;
}
