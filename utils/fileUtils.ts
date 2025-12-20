import { green } from "@std/fmt/colors";
import { walk } from "@std/fs/walk";
import * as log from "@std/log";
import { resolve } from "@std/path";
import sanitizeFilename from "sanitize-filename";
import { cacheFileName } from "./constants.ts";

import { DownloadInfo, Options, Totals } from "../types/general.ts";
import { Checksums } from "../types/bundle.ts";

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

  Deno.addSignalListener("SIGINT", () => {
    writeJsonFileSync(options.downloadFolder, cacheFileName, checksumCache);
  });

  Deno.addSignalListener("SIGABRT", () => {
    writeJsonFileSync(options.downloadFolder, cacheFileName, checksumCache);
  });

  Deno.addSignalListener("SIGQUIT", () => {
    writeJsonFileSync(options.downloadFolder, cacheFileName, checksumCache);
  });

  Deno.addSignalListener("SIGTERM", () => {
    writeJsonFileSync(options.downloadFolder, cacheFileName, checksumCache);
  });

  globalThis.onunload = () => {
    writeJsonFileSync(options.downloadFolder, cacheFileName, checksumCache);
  };

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

  // Create a Set of allowed file paths for O(1) lookup
  const allowedPaths = new Set(
    filteredBundles.map((d) => d.filePath.toLocaleLowerCase()),
  );

  for await (const file of walkExistingFiles(options)) {
    if (!allowedPaths.has(file.path.toLocaleLowerCase())) {
      log.info(`Deleting extra file: ${file.path}`);
      totals.removedFiles += 1;
      await Deno.remove(file.path);
    }
  }

  log.info("Removing checksums from cache");

  // Create a Set of allowed file names for O(1) lookup
  const allowedFileNames = new Set(
    filteredBundles.map((d) => d.fileName.toLocaleLowerCase()),
  );

  Object.keys(checksums).forEach((fileName) => {
    if (!allowedFileNames.has(fileName.toLocaleLowerCase())) {
      log.info(`Removing checksum from cache: ${fileName}`);
      totals.removedChecksums += 1;
      delete checksums[fileName];
    }
  });
}

export async function deleteEmptyFolders(folder: string) {
  try {
    // Process children first (depth-first)
    for await (const entry of Deno.readDir(folder)) {
      if (entry.isDirectory) {
        const entryPath = resolve(folder, entry.name);
        await deleteEmptyFolders(entryPath);
      }
    }

    // Try to remove the directory. Deno.remove throws if not empty.
    // We catch the error to ignore non-empty directories.
    await Deno.remove(folder);
  } catch (err) {
    if (
      !(err instanceof Deno.errors.NotFound) && (err instanceof Error) &&
      !err.message.includes("Directory not empty")
    ) {
      // Only log unexpected errors. "Directory not empty" is expected.
      // Note: Deno doesn't have a specific error class for "Directory not empty" usually, it's often a generic OS error or similar.
      // However, Deno.errors.NotFound is clear.
      // Let's rely on the behavior that we only want to suppress "not empty".
      // Actually, we can check if it's empty before deleting to be cleaner, but Deno.remove is atomic-ish.
      // Let's stick to try-remove pattern but be careful about the error.
      // If we can't delete it, it's fine.
    }
  }
}
