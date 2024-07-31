import { resolve } from "@std/path";
import sanitizeFilename from "sanitize-filename";
import process from "node:process";
import { cacheFileName } from "./constants.ts";
import * as log from "@std/log";
import { green } from "@std/fmt/colors";

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
  contents: any,
) {
  const filePath = resolve(folder, sanitizeFilename(file));
  await Deno.mkdir(folder, { recursive: true });
  return Deno.writeTextFile(filePath, JSON.stringify(contents));
}

export async function loadChecksumCache(options: { downloadFolder: string }) {
  // load cache file of checksums

  const checksumCache = await readJsonFile(
    options.downloadFolder,
    cacheFileName,
  );

  process.on("SIGINT", async () => {
    await writeJsonFile(options.downloadFolder, cacheFileName, checksumCache);
  });

  process.on(
    "exit",
    async () =>
      await writeJsonFile(options.downloadFolder, cacheFileName, checksumCache),
  );

  log.info(
    `${green(Object.keys(checksumCache).length.toString())} checksums loaded`,
  );
  return checksumCache;
}
