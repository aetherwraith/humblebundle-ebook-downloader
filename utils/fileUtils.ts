import { isEql } from "@opentf/std";
import { green } from "@std/fmt/colors";
import { walk } from "@std/fs/walk";
import * as log from "@std/log";
import { resolve } from "@std/path";
import process from "node:process";
import sanitizeFilename from "sanitize-filename";
import { cacheFileName } from "./constants.ts";
import { DownloadInfo } from "./orders.ts";
import { Checksums, Options, Totals } from "./types.ts";

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

  const checksumCache: Record<string, Checksums> = await readJsonFile(
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

export function walkExistingFiles(options: Options) {
  return walk(options.downloadFolder, {
    includeDirs: false,
    includeSymlinks: false,
    skip: [/json/],
  });
}

export async function clean(
  filteredBundles: DownloadInfo[],
  checksums: Record<string, Checksums>,
  options: Options,
  totals: Totals,
) {
  log.info("Removing files...");
  const existingFiles = [];
  for await (const file of walkExistingFiles(options)) {
    if (
      !filteredBundles.some((download) =>
        isEql(
          file.path.toLocaleLowerCase(),
          download.filePath.toLocaleLowerCase(),
        )
      )
    ) {
      log.info(`Deleting extra file: ${file.path}`);
      totals.removedFiles += 1;
      await Deno.remove(file.path);
    }
  }
  await writeJsonFile(
    options.downloadFolder,
    "existingFiles.json",
    existingFiles,
  );
  log.info("Removing checksums from cache");
  Object.keys(checksums).forEach((fileName) => {
    if (
      !filteredBundles.some((download) =>
        isEql(
          fileName.toLocaleLowerCase(),
          download.fileName.toLocaleLowerCase(),
        )
      )
    ) {
      log.info(`Removing checksum from cache: ${fileName}`);
      totals.removedChecksums += 1;
      delete checksums[fileName];
    }
  });
}
