import { cyan, green, red, yellow } from "@std/fmt/colors";
import { format } from "@std/fmt/bytes";
import { walk } from "@std/fs/walk";
import { basename, extname, resolve } from "@std/path";
import { getChecksumCacheKey } from "./checksums.ts";
import { cacheFileName, logFileName } from "./constants.ts";
import {
  compileItemFilters,
  replaceFileExtension,
  sanitizeFilename,
  stripFileExtension,
} from "./generic.ts";
import { MultiBarWrapper } from "./progressWrapper.ts";

import { DownloadInfo, Options, Totals } from "../types/general.ts";
import { Bundle, Checksums } from "../types/bundle.ts";

// Memoized set of directory paths already created during this process run
const ensuredDirs = new Set<string>();

// Tracks whether a loaded checksums dictionary has been modified since disk load/save
const checksumDirtyState = new WeakMap<object, { dirty: boolean }>();

function wrapChecksumCache(
  raw: Record<string, Checksums>,
): Record<string, Checksums> {
  const state = { dirty: false };
  const entryProxyCache = new WeakMap<object, Checksums>();

  const wrapEntry = (entry: Checksums): Checksums => {
    const cached = entryProxyCache.get(entry);
    if (cached) return cached;
    const proxied = new Proxy(entry, {
      set(target, prop, value, receiver) {
        if (Reflect.get(target, prop, receiver) !== value) {
          state.dirty = true;
        }
        return Reflect.set(target, prop, value, receiver);
      },
      deleteProperty(target, prop) {
        if (Reflect.has(target, prop)) {
          state.dirty = true;
        }
        return Reflect.deleteProperty(target, prop);
      },
    });
    entryProxyCache.set(entry, proxied);
    entryProxyCache.set(proxied, proxied);
    return proxied;
  };

  const proxy = new Proxy(raw, {
    get(target, prop, receiver) {
      const val = Reflect.get(target, prop, receiver);
      if (val && typeof val === "object") {
        return wrapEntry(val as Checksums);
      }
      return val;
    },
    set(target, prop, value, receiver) {
      if (Reflect.get(target, prop, receiver) !== value) {
        state.dirty = true;
      }
      return Reflect.set(target, prop, value, receiver);
    },
    deleteProperty(target, prop) {
      if (Reflect.has(target, prop)) {
        state.dirty = true;
      }
      return Reflect.deleteProperty(target, prop);
    },
  });

  checksumDirtyState.set(proxy, state);
  return proxy;
}

/**
 * Returns true if `checksums` has been modified since it was loaded or last saved.
 */
export function isChecksumCacheDirty(
  checksums: Record<string, Checksums>,
): boolean {
  const state = checksumDirtyState.get(checksums);
  return state ? state.dirty : true;
}

/**
 * Marks `checksums` as clean after persisting to disk.
 */
export function markChecksumCacheClean(
  checksums: Record<string, Checksums>,
): void {
  const state = checksumDirtyState.get(checksums);
  if (state) state.dirty = false;
}

/**
 * Ensures a directory exists on disk, memoizing the resolved path in memory
 * to avoid redundant `Deno.mkdir` syscalls across thousands of items.
 */
export async function ensureDirCached(dirPath: string): Promise<void> {
  const resolved = resolve(dirPath);
  if (ensuredDirs.has(resolved)) return;
  await Deno.mkdir(resolved, { recursive: true });
  ensuredDirs.add(resolved);
}

/**
 * Reads and parses a JSON file from disk. Returns an empty object if the file cannot be read.
 *
 * @param folder Directory containing the file
 * @param file Name of the JSON file
 * @returns Parsed JSON contents typed as T
 */
export async function readJsonFile<T = Record<string, unknown>>(
  folder: string,
  file: string,
): Promise<T> {
  const filePath = resolve(folder, sanitizeFilename(file));

  const contents = await Deno.readTextFile(filePath).catch((_) => {
    return "{}";
  });

  try {
    return JSON.parse(contents) as T;
  } catch {
    return {} as T;
  }
}

/**
 * Serializes and writes an object as formatted JSON atomically via temp file + rename.
 *
 * @param folder Destination directory
 * @param file Output file name
 * @param contents Object or array to serialize
 */
export async function writeJsonFile(
  folder: string,
  file: string,
  contents: unknown,
): Promise<void> {
  const filePath = resolve(folder, sanitizeFilename(file));
  const tmpPath = `${filePath}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  await ensureDirCached(folder);
  await Deno.writeTextFile(tmpPath, JSON.stringify(contents, null, 2));
  await Deno.rename(tmpPath, filePath);
  if (contents && typeof contents === "object") {
    markChecksumCacheClean(contents as Record<string, Checksums>);
  }
}

/**
 * Serializes and writes an object as formatted JSON synchronously and atomically (used during signal exits).
 *
 * @param folder Destination directory
 * @param file Output file name
 * @param contents Object or array to serialize
 */
export function writeJsonFileSync(
  folder: string,
  file: string,
  contents: unknown,
): void {
  const filePath = resolve(folder, sanitizeFilename(file));
  const tmpPath = `${filePath}.${Deno.pid}.tmp`;
  Deno.mkdirSync(folder, { recursive: true });
  Deno.writeTextFileSync(tmpPath, JSON.stringify(contents, null, 2));
  Deno.renameSync(tmpPath, filePath);
  if (contents && typeof contents === "object") {
    markChecksumCacheClean(contents as Record<string, Checksums>);
  }
}

/**
 * Loads the checksum cache from disk wrapped in a dirty-tracking proxy so unchanged
 * caches avoid redundant serialization and disk writes on exit.
 *
 * @param options Runtime options containing downloadFolder
 * @param progress Optional MultiBarWrapper logger
 * @returns In-memory checksum cache dictionary
 */
export async function loadChecksumCache(
  options: Options,
  progress?: MultiBarWrapper,
): Promise<Record<string, Checksums>> {
  const rawCache: Record<string, Checksums> = await readJsonFile(
    options.downloadFolder,
    cacheFileName,
  );
  const checksumCache = wrapChecksumCache(rawCache);

  const msg = `${green(Object.keys(rawCache).length.toString())} checksums loaded`;
  if (progress) {
    progress.log(msg);
  } else {
    console.log(msg);
  }
  return checksumCache;
}

/**
 * Async generator yielding all existing non-JSON and non-log files in the download folder.
 *
 * @param options Runtime options containing downloadFolder
 * @param includePartFiles Whether to include temporary .part files (true for clean(), false for checksums)
 */
export function walkExistingFiles(options: Options, includePartFiles = false) {
  return walk(options.downloadFolder, {
    includeDirs: false,
    includeSymlinks: false,
    skip: includePartFiles
      ? [/\.json$/i, /\.log$/i, /\.tmp$/i]
      : [/\.json$/i, /\.log$/i, /\.part$/i, /\.tmp$/i],
  });
}

/**
 * Cleans the download folder and checksum cache by deleting extraneous files
 * that are no longer part of the filtered downloads list.
 *
 * @param filteredBundles List of valid downloads
 * @param checksums Checksum cache dictionary
 * @param options Runtime options
 * @param totals Statistics tracker
 * @param progress Optional MultiBarWrapper logger
 * @param activePartFiles Optional set of currently active .part file paths to protect
 */
export async function clean(
  filteredBundles: DownloadInfo[],
  checksums: Record<string, Checksums>,
  options: Options,
  totals: Totals,
  progress?: MultiBarWrapper,
  activePartFiles?: ReadonlySet<string>,
): Promise<void> {
  const debugLog = (msg: string) => {
    if (progress) {
      progress.debug(msg);
    } else if (options.verbose) {
      console.log(msg);
    }
  };
  const infoLog = (msg: string) => {
    if (progress) {
      progress.log(msg);
    } else {
      console.log(msg);
    }
  };

  if (compileItemFilters(options).hasSubsetFilter) {
    debugLog(
      "Skipping cleanup of existing files because a subset filter (--bundle-key, --filter, --exclude, --since, --before, --max-size, or --min-size) is active.",
    );
    return;
  }

  debugLog("Removing extra files...");

  // Create a Set of allowed file paths for O(1) lookup
  const allowedPaths = new Set<string>();
  const extractedPrefixes: string[] = [];
  allowedPaths.add(resolve(options.downloadFolder, logFileName).toLowerCase());
  if (options.logFile) {
    allowedPaths.add(resolve(options.logFile).toLowerCase());
  }
  if (activePartFiles) {
    for (const part of activePartFiles) {
      allowedPaths.add(resolve(part).toLowerCase());
    }
  }
  const COVER_SIDECAR_EXTS = [
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".gif",
    ".avif",
  ];
  for (const d of filteredBundles) {
    allowedPaths.add(resolve(d.filePath).toLowerCase());
    // Protect existing .opf metadata and cover art sidecars alongside valid library items
    // (including when Humble's migrated API omits `icon` or when sidecar flags aren't re-passed)
    allowedPaths.add(
      resolve(replaceFileExtension(d.filePath, ".opf")).toLowerCase(),
    );
    const coverPath = getCoverSidecarPath(d);
    if (coverPath) {
      allowedPaths.add(resolve(coverPath).toLowerCase());
    }
    for (const ext of COVER_SIDECAR_EXTS) {
      allowedPaths.add(
        resolve(replaceFileExtension(d.filePath, ext)).toLowerCase(),
      );
    }
    if (options.playlists && isAudioFile(d.fileName)) {
      allowedPaths.add(
        getPlaylistPathForFolder(d.downloadPath).toLowerCase(),
      );
    }
    if (options.extract && isExtractableArchive(d.filePath)) {
      extractedPrefixes.push(
        `${getExtractedDirPath(d.filePath).toLowerCase()}/`,
      );
    }
  }

  for await (const file of walkExistingFiles(options, true)) {
    const lowerPath = resolve(file.path).toLowerCase();
    const isInsideExtracted = extractedPrefixes.some((p) =>
      lowerPath.startsWith(p.replace(/\\/g, "/")) || lowerPath.startsWith(p)
    );
    if (!allowedPaths.has(lowerPath) && !isInsideExtracted) {
      if (options.dryRun) {
        infoLog(`[Dry Run] Would delete extra file: ${file.path}`);
        totals.removedFiles += 1;
      } else {
        debugLog(`Deleting extra file: ${file.path}`);
        totals.removedFiles += 1;
        await Deno.remove(file.path).catch(() => {});
      }
    }
  }

  debugLog("Removing stale checksums from cache...");

  // Create a Set of allowed cache keys (both relative path and fileName) for O(1) lookup
  const allowedCacheKeys = new Set<string>();
  for (const d of filteredBundles) {
    allowedCacheKeys.add(d.fileName.toLowerCase());
    allowedCacheKeys.add(
      getChecksumCacheKey(
        d.filePath,
        d.fileName,
        options.downloadFolder,
      ).toLowerCase(),
    );
  }

  for (const key of Object.keys(checksums)) {
    if (!allowedCacheKeys.has(key.toLowerCase())) {
      debugLog(`Removing checksum from cache: ${key}`);
      totals.removedChecksums += 1;
      if (!options.dryRun) {
        delete checksums[key];
      }
    }
  }
}

/**
 * Recursively removes empty subfolders within a directory, traversing sibling
 * subdirectories concurrently.
 *
 * @param folder Root folder path to clean
 * @param isRoot Whether this is the top-level download folder (default true; prevents deleting the root itself)
 */
export async function deleteEmptyFolders(
  folder: string,
  isRoot = true,
): Promise<void> {
  try {
    const subDirs: string[] = [];
    for await (const entry of Deno.readDir(folder)) {
      if (entry.isDirectory) {
        subDirs.push(resolve(folder, entry.name));
      }
    }
    if (subDirs.length > 0) {
      await Promise.all(subDirs.map((d) => deleteEmptyFolders(d, false)));
    }

    // Try to remove directory if not root. Deno.remove throws if not empty.
    if (!isRoot) {
      await Deno.remove(folder);
      ensuredDirs.delete(resolve(folder));
    }
  } catch (_err) {
    // Suppress expected errors when directory is not empty
  }
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Resolves the local file path where a download's cover image sidecar should be saved.
 */
export function getCoverSidecarPath(download: DownloadInfo): string | undefined {
  if (!download.icon) return undefined;
  let ext = ".jpg";
  try {
    const iconUrl = new URL(download.icon);
    const parsedExt = extname(basename(iconUrl.pathname)).toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(parsedExt)) {
      ext = parsedExt;
    }
  } catch {
    // Default to .jpg
  }
  return resolve(replaceFileExtension(download.filePath, ext));
}

const inFlightCovers = new Map<string, Promise<string | undefined>>();

/**
 * Downloads the item's cover image (`download.icon`) next to the target file if not already present.
 * Deduplicates concurrent requests for the same cover sidecar path.
 */
export function downloadCoverArt(
  download: DownloadInfo,
  overwrite = false,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (!download.icon) return Promise.resolve(undefined);
  const coverPath = getCoverSidecarPath(download);
  if (!coverPath) return Promise.resolve(undefined);

  const key = coverPath.toLowerCase();
  const existingPromise = inFlightCovers.get(key);
  if (existingPromise) return existingPromise;

  const task = (async (): Promise<string | undefined> => {
    if (!overwrite) {
      try {
        const stat = await Deno.stat(coverPath);
        if (stat.isFile && stat.size > 0) return coverPath;
      } catch {
        // Does not exist yet
      }
    }

    try {
      const resp = await fetch(download.icon!, { signal });
      if (!resp.ok || !resp.body) return undefined;
      await ensureDirCached(download.downloadPath);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      await Deno.writeFile(coverPath, bytes);
      return coverPath;
    } catch {
      return undefined;
    } finally {
      inFlightCovers.delete(key);
    }
  })();

  inFlightCovers.set(key, task);
  return task;
}

const EXTRACTABLE_ARCHIVE_RE = /\.(zip|tar\.gz|tgz|tar\.bz2|tar\.xz)$/i;

/**
 * Checks whether a file path is an extractable archive (`.zip`, `.tar.gz`, `.tgz`, `.tar.bz2`, `.tar.xz`).
 */
export function isExtractableArchive(filePath: string): boolean {
  return EXTRACTABLE_ARCHIVE_RE.test(filePath);
}

/**
 * Returns the target directory path where an archive will be extracted.
 */
export function getExtractedDirPath(filePath: string): string {
  return resolve(filePath.replace(EXTRACTABLE_ARCHIVE_RE, ""));
}

/**
 * Extracts a `.zip` or `.tar.*` / `.tgz` archive into `<downloadPath>/<archiveStem>/`
 * if not already extracted.
 */
export async function extractArchive(
  filePath: string,
  overwrite = false,
  progress?: MultiBarWrapper,
): Promise<boolean> {
  if (!isExtractableArchive(filePath)) return false;
  const destDir = getExtractedDirPath(filePath);

  if (!overwrite) {
    try {
      const st = await Deno.stat(destDir);
      if (st.isDirectory) return true;
    } catch {
      // Directory does not exist yet
    }
  }

  await ensureDirCached(destDir);
  const lower = filePath.toLowerCase();
  const cmd = lower.endsWith(".zip")
    ? new Deno.Command("unzip", {
      args: ["-q", "-o", resolve(filePath), "-d", destDir],
      stdout: "null",
      stderr: "null",
    })
    : new Deno.Command("tar", {
      args: ["-xf", resolve(filePath), "-C", destDir],
      stdout: "null",
      stderr: "null",
    });

  try {
    const { success } = await cmd.output();
    if (success) {
      progress?.debug?.(`Extracted archive: ${filePath} -> ${destDir}`);
    }
    return success;
  } catch {
    return false;
  }
}

const AUDIO_EXT_RE = /\.(mp3|flac|ogg|wav|m4a|aac|opus)$/i;

/**
 * Checks if a filename has a supported audio extension.
 */
export function isAudioFile(fileName: string): boolean {
  return AUDIO_EXT_RE.test(fileName);
}

/**
 * Returns the path for the `.m3u8` playlist inside an audio download directory.
 */
export function getPlaylistPathForFolder(downloadPath: string): string {
  const folderName = sanitizeFilename(basename(resolve(downloadPath))) ||
    "playlist";
  return resolve(downloadPath, `${folderName}.m3u8`);
}

/**
 * Generates `.m3u8` playlists for each folder containing audio tracks in `filteredBundles`.
 */
export async function generateAudioPlaylists(
  filteredBundles: DownloadInfo[],
  dryRun = false,
): Promise<string[]> {
  const byFolder = new Map<string, DownloadInfo[]>();
  for (const item of filteredBundles) {
    if (!isAudioFile(item.fileName)) continue;
    const folder = resolve(item.downloadPath);
    const list = byFolder.get(folder) ?? [];
    list.push(item);
    byFolder.set(folder, list);
  }

  const createdPlaylists: string[] = [];
  for (const [folder, items] of byFolder.entries()) {
    items.sort((a, b) =>
      a.fileName.localeCompare(b.fileName, undefined, {
        numeric: true,
        sensitivity: "base",
      })
    );
    const playlistPath = getPlaylistPathForFolder(folder);
    const lines = ["#EXTM3U"];
    for (const track of items) {
      const displayTitle = stripFileExtension(track.fileName);
      lines.push(`#EXTINF:-1,${track.name} - ${displayTitle}`);
      lines.push(track.fileName);
    }
    if (!dryRun) {
      await ensureDirCached(folder);
      await Deno.writeTextFile(playlistPath, `${lines.join("\n")}\n`);
    }
    createdPlaylists.push(playlistPath);
  }
  return createdPlaylists;
}

/**
 * Generates a Calibre/Komga/Kavita compatible OPF XML sidecar file alongside an ebook.
 * Skips writing if `overwrite` is false and the `.opf` file already exists on disk.
 */
export async function writeOpfSidecar(
  download: DownloadInfo,
  overwrite = true,
): Promise<void> {
  const opfPath = resolve(replaceFileExtension(download.filePath, ".opf"));
  if (!overwrite) {
    try {
      const stat = await Deno.stat(opfPath);
      if (stat.isFile && stat.size > 0) return;
    } catch {
      // File doesn't exist yet, proceed to write
    }
  }

  const title = escapeXml(download.name);
  const creator = escapeXml(download.publisher ?? "Humble Bundle");
  const series = escapeXml(download.bundle);
  const dateStr = download.date.toISOString().split("T")[0];
  const identifier = escapeXml(`${download.gameKey}:${download.machineName}`);
  const coverPath = getCoverSidecarPath(download);
  const coverTag = coverPath
    ? `\n    <meta name="cover" content="${escapeXml(basename(coverPath))}"/>`
    : "";

  const opfXml = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="hb_id" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>${title}</dc:title>
    <dc:creator opf:role="aut">${creator}</dc:creator>
    <dc:publisher>${creator}</dc:publisher>
    <dc:date>${dateStr}</dc:date>
    <dc:identifier id="hb_id">${identifier}</dc:identifier>
    <meta name="calibre:series" content="${series}"/>${coverTag}
  </metadata>
</package>
`;
  await ensureDirCached(download.downloadPath);
  await Deno.writeTextFile(opfPath, opfXml);
}

/**
 * Exports a searchable catalog of all filtered items as both `catalog.json` and `catalog.csv`
 * in the download folder.
 */
export async function exportCatalog(
  filteredBundles: DownloadInfo[],
  downloadFolder: string,
): Promise<void> {
  const catalogItems = filteredBundles.map((d) => ({
    title: d.name,
    bundle: d.bundle,
    publisher: d.publisher ?? "",
    format: d.structName,
    fileName: d.fileName,
    filePath: d.filePath,
    fileSize: d.file_size ?? 0,
    date: d.date.toISOString(),
    sha1: d.sha1 ?? "",
    md5: d.md5 ?? "",
    productUrl: d.productUrl ?? "",
    icon: d.icon ?? "",
  }));

  await writeJsonFile(downloadFolder, "catalog.json", catalogItems);

  const csvQuote = (val: string | number) =>
    `"${String(val).replace(/"/g, '""')}"`;
  const headers = [
    "Title",
    "Bundle",
    "Publisher",
    "Format",
    "FileName",
    "FilePath",
    "FileSize",
    "Date",
    "SHA1",
    "MD5",
    "ProductURL",
    "IconURL",
  ];
  const rows = [
    headers.join(","),
    ...catalogItems.map((item) =>
      [
        item.title,
        item.bundle,
        item.publisher,
        item.format,
        item.fileName,
        item.filePath,
        item.fileSize,
        item.date,
        item.sha1,
        item.md5,
        item.productUrl,
        item.icon,
      ].map(csvQuote).join(",")
    ),
  ];

  await ensureDirCached(downloadFolder);
  await Deno.writeTextFile(
    resolve(downloadFolder, "catalog.csv"),
    rows.join("\n"),
  );
}

/**
 * Prints a formatted summary of library statistics (bundles, formats, total sizes,
 * and local disk verification status) for the `stats` / `list` command.
 */
export async function printLibraryStats(
  filteredBundles: DownloadInfo[],
  checksums: Record<string, Checksums>,
  downloadFolder: string,
  totalBundlesCount: number,
  jsonOutput = false,
): Promise<void> {
  let totalBytes = 0;
  let downloadedBytes = 0;
  let downloadedCount = 0;
  const byFormat = new Map<string, { count: number; bytes: number }>();
  const byPublisher = new Map<string, { count: number; bytes: number }>();
  const uncachedItems: DownloadInfo[] = [];

  for (const item of filteredBundles) {
    const size = item.file_size ?? 0;
    totalBytes += size;

    const fmtKey = item.structName.toUpperCase();
    const fmtEntry = byFormat.get(fmtKey) ?? { count: 0, bytes: 0 };
    fmtEntry.count++;
    fmtEntry.bytes += size;
    byFormat.set(fmtKey, fmtEntry);

    if (item.publisher) {
      const pubEntry = byPublisher.get(item.publisher) ?? {
        count: 0,
        bytes: 0,
      };
      pubEntry.count++;
      pubEntry.bytes += size;
      byPublisher.set(item.publisher, pubEntry);
    }

    const cacheKey = getChecksumCacheKey(
      item.filePath,
      item.fileName,
      downloadFolder,
    );
    if (checksums[cacheKey] || checksums[item.fileName]) {
      downloadedCount++;
      downloadedBytes += size;
    } else {
      uncachedItems.push(item);
    }
  }

  // Check uncached items on disk concurrently in batches of 32
  const BATCH_SIZE = 32;
  for (let i = 0; i < uncachedItems.length; i += BATCH_SIZE) {
    const batch = uncachedItems.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (item) => {
        try {
          const st = await Deno.stat(item.filePath);
          return st.isFile ? (item.file_size ?? 0) : null;
        } catch {
          return null;
        }
      }),
    );
    for (const size of results) {
      if (size !== null) {
        downloadedCount++;
        downloadedBytes += size;
      }
    }
  }

  const sortedFormats = [...byFormat.entries()].sort(
    (a, b) => b[1].count - a[1].count,
  );
  const sortedPublishers = [...byPublisher.entries()]
    .sort((a, b) => b[1].count - a[1].count || b[1].bytes - a[1].bytes)
    .slice(0, 10);

  if (jsonOutput) {
    console.log(
      JSON.stringify(
        {
          totalBundles: totalBundlesCount,
          matchedItems: filteredBundles.length,
          totalBytes,
          downloadedCount,
          downloadedBytes,
          missingCount: filteredBundles.length - downloadedCount,
          missingBytes: Math.max(0, totalBytes - downloadedBytes),
          formats: Object.fromEntries(sortedFormats),
          topPublishers: Object.fromEntries(sortedPublishers),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`\n${cyan("=== Humble Bundle Library Statistics ===")}`);
  console.log(`Total Bundles:      ${yellow(totalBundlesCount.toString())}`);
  console.log(
    `Matched Items:      ${yellow(filteredBundles.length.toString())} (${format(totalBytes)})`,
  );
  console.log(
    `Downloaded Locally: ${green(downloadedCount.toString())} / ${filteredBundles.length} (${format(downloadedBytes)})`,
  );
  console.log(
    `Missing Locally:    ${yellow((filteredBundles.length - downloadedCount).toString())} (${format(Math.max(0, totalBytes - downloadedBytes))})`,
  );

  if (sortedFormats.length > 0) {
    console.log(`\n${cyan("--- Breakdown by Format ---")}`);
    for (const [fmt, info] of sortedFormats) {
      console.log(
        `  ${fmt.padEnd(12)} : ${info.count.toString().padStart(5)} items (${format(info.bytes)})`,
      );
    }
  }

  if (sortedPublishers.length > 0) {
    console.log(`\n${cyan("--- Top Publishers ---")}`);
    for (const [pub, info] of sortedPublishers) {
      console.log(
        `  ${pub.slice(0, 28).padEnd(28)} : ${info.count.toString().padStart(5)} items (${format(info.bytes)})`,
      );
    }
  }
  console.log("");
}

/**
 * Prints a chronological list of all purchased bundles with their gamekey,
 * purchase date, matched item count, total size, and local download status (`bundles` command).
 */
export async function printBundlesList(
  bundles: Bundle[],
  filteredBundles: DownloadInfo[],
  checksums: Record<string, Checksums>,
  downloadFolder: string,
  jsonOutput = false,
  options?: Partial<Options>,
): Promise<void> {
  const filters = options ? compileItemFilters(options) : undefined;
  const visibleBundles = filters
    ? bundles.filter(
      (b) =>
        filters.matchesBundleKey(b.gamekey ?? "") &&
        filters.matchesDate(new Date(b.created)) &&
        filters.matchesText(
          b.product.human_name,
          b.product.machine_name,
          ...b.subproducts.map((sp) => sp.human_name),
        ),
    )
    : bundles;

  const byGameKey = new Map<
    string,
    { total: number; downloaded: number; bytes: number }
  >();
  const uncachedChecks: { gameKey: string; filePath: string }[] = [];

  for (const item of filteredBundles) {
    const entry = byGameKey.get(item.gameKey) ?? {
      total: 0,
      downloaded: 0,
      bytes: 0,
    };
    entry.total++;
    entry.bytes += item.file_size ?? 0;

    const cacheKey = getChecksumCacheKey(
      item.filePath,
      item.fileName,
      downloadFolder,
    );
    if (checksums[cacheKey] || checksums[item.fileName]) {
      entry.downloaded++;
    } else {
      uncachedChecks.push({ gameKey: item.gameKey, filePath: item.filePath });
    }
    byGameKey.set(item.gameKey, entry);
  }

  const BATCH_SIZE = 32;
  for (let i = 0; i < uncachedChecks.length; i += BATCH_SIZE) {
    const batch = uncachedChecks.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (chk) => {
        try {
          const st = await Deno.stat(chk.filePath);
          return st.isFile ? chk.gameKey : null;
        } catch {
          return null;
        }
      }),
    );
    for (const gk of results) {
      if (gk) {
        const entry = byGameKey.get(gk);
        if (entry) entry.downloaded++;
      }
    }
  }

  const rows = visibleBundles.map((b) => {
    const stats = byGameKey.get(b.gamekey) ?? {
      total: 0,
      downloaded: 0,
      bytes: 0,
    };
    return {
      date: new Date(b.created).toISOString().split("T")[0],
      gameKey: b.gamekey,
      name: b.product.human_name,
      downloaded: stats.downloaded,
      total: stats.total,
      bytes: stats.bytes,
      choicesRemaining: b.choices_remaining ?? 0,
    };
  });

  if (jsonOutput) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  console.log(`\n${cyan(`=== Purchased Bundles (${rows.length}) ===`)}`);
  for (const r of rows) {
    const statusStr = `${r.downloaded}/${r.total}`.padStart(7);
    const statusColor = r.total > 0 && r.downloaded === r.total ? green : yellow;
    const choiceBadge = r.choicesRemaining > 0
      ? ` ${yellow(`[${r.choicesRemaining} choice(s) left]`)}`
      : "";
    console.log(
      `  ${r.date} | ${r.gameKey.padEnd(16)} | ${statusColor(statusStr)} (${format(r.bytes).padStart(9)}) | ${r.name}${choiceBadge}`,
    );
  }
  console.log("");
}

export interface UnclaimedReport {
  unclaimedChoices: {
    date: string;
    gameKey: string;
    bundle: string;
    choicesRemaining: number;
    totalChoices: number;
    choiceUrl?: string;
  }[];
  unredeemedKeys: {
    date: string;
    gameKey: string;
    bundle: string;
    keyCount: number;
    items: string[];
  }[];
  externalLinks: {
    bundle: string;
    gameKey: string;
    product: string;
    label: string;
    url: string;
  }[];
}

/**
 * Inspects `bundles` for unclaimed Humble Choice picks, unredeemed third-party keys
 * (`empty_tpkds`), and external-link-only downloads (`unclaimed` command).
 */
export function buildUnclaimedReport(
  bundles: Bundle[],
  options?: Partial<Options>,
): UnclaimedReport {
  const filters = options ? compileItemFilters(options) : undefined;
  const unclaimedChoices: UnclaimedReport["unclaimedChoices"] = [];
  const unredeemedKeys: UnclaimedReport["unredeemedKeys"] = [];
  const externalLinks: UnclaimedReport["externalLinks"] = [];

  for (const b of bundles) {
    if (filters && !filters.matchesBundleKey(b.gamekey ?? "")) continue;
    const createdDate = new Date(b.created);
    if (filters && !filters.matchesDate(createdDate)) continue;
    if (
      filters &&
      !filters.matchesText(b.product.human_name, b.product.machine_name)
    ) {
      continue;
    }

    const dateStr = isNaN(createdDate.getTime())
      ? ""
      : createdDate.toISOString().split("T")[0];

    if ((b.choices_remaining ?? 0) > 0) {
      unclaimedChoices.push({
        date: dateStr,
        gameKey: b.gamekey,
        bundle: b.product.human_name,
        choicesRemaining: b.choices_remaining,
        totalChoices: b.total_choices ?? b.choices_remaining,
        choiceUrl: b.product.choice_url
          ? `https://www.humblebundle.com/membership/${b.product.choice_url}`
          : `https://www.humblebundle.com/downloads?key=${b.gamekey}`,
      });
    }

    const rawTpkds = b.product.empty_tpkds as unknown;
    const keyLabels: string[] = [];
    if (Array.isArray(rawTpkds)) {
      for (const entry of rawTpkds) {
        if (entry && typeof entry === "object") {
          const rec = entry as Record<string, unknown>;
          if (!rec.redeemed_key_val) {
            keyLabels.push(
              String(rec.human_name ?? rec.machine_name ?? "Unredeemed Key"),
            );
          }
        }
      }
    } else if (rawTpkds && typeof rawTpkds === "object") {
      for (const [k, v] of Object.entries(rawTpkds as Record<string, unknown>)) {
        if (Array.isArray(v) && v.length > 0) {
          keyLabels.push(`${k} (${v.length})`);
        } else if (v && typeof v === "object") {
          keyLabels.push(k);
        }
      }
    }
    if (keyLabels.length > 0) {
      unredeemedKeys.push({
        date: dateStr,
        gameKey: b.gamekey,
        bundle: b.product.human_name,
        keyCount: keyLabels.length,
        items: keyLabels,
      });
    }

    for (const sp of b.subproducts ?? []) {
      for (const dl of sp.downloads ?? []) {
        for (const st of dl.download_struct ?? []) {
          if (st.external_link && !st.url?.web) {
            externalLinks.push({
              bundle: b.product.human_name,
              gameKey: b.gamekey,
              product: sp.human_name,
              label: st.name ?? dl.platform,
              url: st.external_link,
            });
          }
        }
      }
    }
  }

  return { unclaimedChoices, unredeemedKeys, externalLinks };
}

/**
 * Prints the `unclaimed` report to stdout as a formatted table or machine-readable JSON.
 */
export function printUnclaimedReport(
  bundles: Bundle[],
  jsonOutput = false,
  options?: Partial<Options>,
): void {
  const report = buildUnclaimedReport(bundles, options);
  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`\n${cyan("=== Unclaimed Choices, Keys & External Links ===")}`);
  console.log(
    `Unclaimed Choice Bundles: ${yellow(report.unclaimedChoices.length.toString())}`,
  );
  for (const c of report.unclaimedChoices) {
    console.log(
      `  ${c.date} | ${c.gameKey.padEnd(16)} | ${yellow(`${c.choicesRemaining}/${c.totalChoices} left`)} | ${c.bundle}`,
    );
  }

  console.log(
    `Bundles w/ Unused Keys:   ${yellow(report.unredeemedKeys.length.toString())}`,
  );
  for (const k of report.unredeemedKeys) {
    console.log(
      `  ${k.date} | ${k.gameKey.padEnd(16)} | ${yellow(`${k.keyCount} key(s)`)} | ${k.bundle}: ${k.items.slice(0, 5).join(", ")}${k.items.length > 5 ? "..." : ""}`,
    );
  }

  console.log(
    `External-Only Downloads:  ${yellow(report.externalLinks.length.toString())}`,
  );
  for (const ext of report.externalLinks) {
    console.log(
      `  ${ext.gameKey.padEnd(16)} | ${ext.product} (${ext.label}) -> ${ext.url}`,
    );
  }
  console.log("");
}

/**
 * Prints a formatted end-of-run summary table and lists any failed downloads.
 */
export function printRunSummary(totals: Totals, jsonOutput = false): void {
  if (jsonOutput) {
    console.log(JSON.stringify(totals, null, 2));
    return;
  }
  console.log(`\n${cyan("=== Run Summary ===")}`);
  console.log(`Bundles Processed:   ${yellow(totals.bundles.toString())}`);
  console.log(
    `Filtered Items:      ${yellow(totals.filteredDownloads.toString())} (from ${totals.preFilteredDownloads} total candidates)`,
  );
  console.log(
    `Checksums Loaded:    ${green(totals.checksumsLoaded.toString())} (computed ${totals.checksums} new)`,
  );
  console.log(
    `Downloads Queued:    ${yellow(totals.downloads.toString())} (${green(totals.doneDownloads.toString())} completed/verified)`,
  );
  if (totals.movedFiles) {
    console.log(
      `Files Relocated:     ${green(totals.movedFiles.toString())}`,
    );
  }
  if (totals.linkedFiles) {
    console.log(
      `Duplicates Linked:   ${green(totals.linkedFiles.toString())}`,
    );
  }
  if (totals.hashErrors > 0) {
    console.log(
      `API Hash Warnings:   ${yellow(totals.hashErrors.toString())}`,
    );
  }
  if (totals.removedFiles > 0 || totals.removedChecksums > 0) {
    console.log(
      `Cleaned Up:          ${totals.removedFiles} extra files, ${totals.removedChecksums} stale checksums`,
    );
  }

  if (totals.failedDownloads && totals.failedDownloads.length > 0) {
    console.log(
      `\n${red(`=== Failed Downloads (${totals.failedDownloads.length}) ===`)}`,
    );
    for (const fail of totals.failedDownloads) {
      console.log(
        `  - ${red(fail.fileName)} (${fail.bundle}): ${fail.error}`,
      );
    }
  }
  console.log("");
}
