import { green } from "@std/fmt/colors";
import { walk } from "@std/fs/walk";
import { resolve } from "@std/path";
import sanitizeFilename from "sanitize-filename";
import { cacheFileName } from "./constants.ts";

import { DownloadInfo, Options, Totals } from "../types/general.ts";
import { Checksums } from "../types/bundle.ts";
import { MultiBar } from "./progress.ts";

/**
 * Read and parse a JSON file
 */
export async function readJsonFile(folder: string, file: string): Promise<any> {
  const filePath = resolve(folder, sanitizeFilename(file));

  try {
    const contents = await Deno.readTextFile(filePath);
    return JSON.parse(contents);
  } catch (_) {
    return {};
  }
}

/**
 * Write an object to a JSON file
 */
export async function writeJsonFile(
  folder: string,
  file: string,
  contents: object,
): Promise<void> {
  const filePath = resolve(folder, sanitizeFilename(file));
  await Deno.mkdir(folder, { recursive: true });
  return Deno.writeTextFile(filePath, JSON.stringify(contents, null, 2));
}

/**
 * Synchronously write an object to a JSON file
 */
export function writeJsonFileSync(
  folder: string,
  file: string,
  contents: object,
): void {
  const filePath = resolve(folder, sanitizeFilename(file));
  Deno.mkdirSync(folder, { recursive: true });
  Deno.writeTextFileSync(filePath, JSON.stringify(contents, null, 2));
}

/**
 * Load checksum cache and set up signal handlers for saving on exit
 */
export async function loadChecksumCache(
  options: Options,
  progress: MultiBar,
): Promise<Record<string, Checksums>> {
  // Load cache file of checksums
  const checksumCache: Record<string, Checksums> = await readJsonFile(
    options.downloadFolder,
    cacheFileName,
  );

  const saveCache = () => {
    writeJsonFileSync(options.downloadFolder, cacheFileName, checksumCache);
  };

  // Set up signal handlers
  const signals = ["SIGINT", "SIGABRT", "SIGQUIT", "SIGTERM"];
  for (const signal of signals) {
    Deno.addSignalListener(signal, () => {
      progress.log(`Received ${signal}, saving cache...`);
      saveCache();
    });
  }

  // Handle unload event
  globalThis.addEventListener("unload", () => {
    progress.log("Unloading, saving cache...");
    saveCache();
  });

  progress.log(
    `${green(Object.keys(checksumCache).length.toString())} checksums loaded`,
  );
  return checksumCache;
}

/**
 * Get an iterator for all files in the download folder, excluding JSON files
 */
export function walkExistingFiles(options: Options) {
  return walk(options.downloadFolder, {
    includeDirs: false,
    includeSymlinks: false,
    skip: [/json/],
  });
}

/**
 * Clean up files and checksums that are no longer needed
 */
export async function clean(
  filteredBundles: DownloadInfo[],
  checksums: Record<string, Checksums>,
  options: Options,
  totals: Totals,
  progress: MultiBar,
): Promise<void> {
  progress.log("Removing files...");
  for await (const file of walkExistingFiles(options)) {
    if (
      !filteredBundles.some((download) =>
        file.path.toLocaleLowerCase() === download.filePath.toLocaleLowerCase()
      )
    ) {
      progress.log(`Deleting extra file: ${file.path}`);
      totals.removedFiles += 1;
      await Deno.remove(file.path);
    }
  }

  progress.log("Removing checksums from cache");
  Object.keys(checksums).forEach((fileName) => {
    if (
      !filteredBundles.some((download) =>
        fileName.toLocaleLowerCase() === download.fileName.toLocaleLowerCase()
      )
    ) {
      progress.log(`Removing checksum from cache: ${fileName}`);
      totals.removedChecksums += 1;
      delete checksums[fileName];
    }
  });
}
