import { crypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";
import { yellow } from "@std/fmt/colors";
import { relative, resolve } from "@std/path";
import { stripFileExtension } from "./generic.ts";
import { MultiBarWrapper, progressDebug } from "./progressWrapper.ts";
import { StreamProgress } from "./streamProgress.ts";

import { DownloadInfo, Totals } from "../types/general.ts";
import { Checksums } from "../types/bundle.ts";

export interface HashOptions {
  sha1?: boolean;
  md5?: boolean;
}

let cachedRawDownloadFolder: string | undefined;
let cachedResolvedDownloadFolder = "";

function resolveDownloadFolderFast(downloadFolder: string): string {
  if (downloadFolder === cachedRawDownloadFolder) {
    return cachedResolvedDownloadFolder;
  }
  cachedRawDownloadFolder = downloadFolder;
  cachedResolvedDownloadFolder = resolve(downloadFolder);
  return cachedResolvedDownloadFolder;
}

/**
 * Determines which hash algorithm(s) are needed to verify `download`
 * (accounting for swapped SHA-1/MD5 fields in the Humble Bundle API),
 * avoiding `stream.tee()` when only a single algorithm is needed.
 */
export function getRequiredHashOptions(
  download: Pick<DownloadInfo, "sha1" | "md5">,
): HashOptions {
  const expSha1Len = download.sha1?.trim().length ?? 0;
  const expMd5Len = download.md5?.trim().length ?? 0;
  const hasAnyExpected = expSha1Len > 0 || expMd5Len > 0;
  return {
    sha1: !hasAnyExpected || expSha1Len === 40 || expMd5Len === 40 ||
      (expSha1Len > 0 && expSha1Len !== 32),
    md5: !hasAnyExpected || expMd5Len === 32 || expSha1Len === 32 ||
      (expMd5Len > 0 && expMd5Len !== 40),
  };
}

/**
 * Returns the canonical cache key for a file (relative path from downloadFolder if provided,
 * otherwise fileName).
 */
export function getChecksumCacheKey(
  filePath: string,
  fileName: string,
  downloadFolder?: string,
): string {
  if (downloadFolder) {
    const rel = relative(
      resolveDownloadFolderFast(downloadFolder),
      resolve(filePath),
    );
    if (rel && !rel.startsWith("..")) {
      return rel.replace(/\\/g, "/");
    }
  }
  return fileName;
}

/**
 * Computes SHA-1 and/or MD5 hashes from a readable byte stream.
 * If only one algorithm is requested, avoids teeing the stream for lower memory & CPU overhead.
 *
 * @param stream ReadableStream of file chunks
 * @param hashOptions Optional flags indicating which hashes to compute (defaults to both)
 * @returns Object containing requested hex-encoded sha1 and/or md5 hashes
 */
export async function computeFileHash(
  stream: ReadableStream<Uint8Array>,
  hashOptions: HashOptions = { sha1: true, md5: true },
): Promise<Checksums> {
  const needSha1 = hashOptions.sha1 ?? true;
  const needMd5 = hashOptions.md5 ?? true;

  if (needSha1 && !needMd5) {
    const shaHashBuffer = await crypto.subtle.digest(
      "SHA-1",
      stream as unknown as AsyncIterable<BufferSource>,
    );
    return { sha1: encodeHex(shaHashBuffer) };
  }

  if (needMd5 && !needSha1) {
    const md5HashBuffer = await crypto.subtle.digest(
      "MD5",
      stream as unknown as AsyncIterable<BufferSource>,
    );
    return { md5: encodeHex(md5HashBuffer) };
  }

  const [shaStream, md5Stream] = stream.tee();
  const [shaHashBuffer, md5HashBuffer] = await Promise.all([
    crypto.subtle.digest(
      "SHA-1",
      shaStream as unknown as AsyncIterable<BufferSource>,
    ),
    crypto.subtle.digest(
      "MD5",
      md5Stream as unknown as AsyncIterable<BufferSource>,
    ),
  ]);
  return {
    sha1: encodeHex(shaHashBuffer),
    md5: encodeHex(md5HashBuffer),
  };
}

/**
 * Calculates the checksum of a file on disk while displaying progress.
 *
 * @param file Absolute or relative path to the file
 * @param progress MultiBarWrapper instance to display hashing progress
 * @param knownSize Optional pre-stat'd file size in bytes
 * @param hashOptions Optional flags indicating which hashes to compute
 * @returns Object containing sha1 and/or md5 hashes
 */
export async function checksum(
  file: string,
  progress: MultiBarWrapper,
  knownSize?: number,
  hashOptions?: HashOptions,
): Promise<Checksums> {
  const filePath = resolve(file);
  const size = knownSize ?? (await Deno.stat(filePath)).size;
  const fileStream = await Deno.open(filePath, { read: true });
  const pipedStreams = fileStream.readable.pipeThrough(
    new StreamProgress(size, file, progress, "Hashing", yellow),
  );
  return computeFileHash(pipedStreams, hashOptions);
}

/**
 * Checks if a downloaded file already exists on disk and matches the expected checksums.
 * Uses cached checksums if available to avoid redundant disk reads.
 * If a file previously completed downloading with an API checksum mismatch (`hashErrors > 0`),
 * verifies that the file on disk still matches that verified download (by size and hash)
 * so it is not endlessly re-downloaded on subsequent runs.
 *
 * @param download Download item metadata
 * @param checksums In-memory checksum cache dictionary
 * @param progress Progress bar wrapper for logging
 * @param totals Totals accumulator
 * @param downloadFolder Optional root download folder for relative path cache keys
 * @returns True if the file exists and passes hash verification
 */
export async function checkSignatureMatch(
  download: DownloadInfo,
  checksums: Record<string, Checksums>,
  progress: MultiBarWrapper,
  totals: Totals,
  downloadFolder?: string,
): Promise<boolean> {
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(download.filePath);
    if (!stat.isFile) return false;
  } catch {
    return false;
  }

  const cacheKey = getChecksumCacheKey(
    download.filePath,
    download.fileName,
    downloadFolder,
  );
  const previousEntry = checksums[cacheKey] ?? checksums[download.fileName];

  const hash = await getOrComputeChecksum(
    download,
    stat.size,
    stat.mtime?.getTime(),
    checksums,
    progress,
    totals,
    downloadFolder,
  );
  const verified = isHashVerified(download, hash);
  if (verified) return true;

  // If this file already had a recorded API hash mismatch and the file on disk
  // still matches that cached entry's hash and size (if recorded), skip re-downloading.
  if (previousEntry?.hashErrors && previousEntry.hashErrors > 0) {
    const fileMtime = stat.mtime?.getTime();
    // Zero-read fast path: if size and mtime match the previously verified download on disk
    if (
      previousEntry.verifiedSize !== undefined &&
      previousEntry.verifiedSize === stat.size &&
      previousEntry.verifiedMtime !== undefined &&
      fileMtime !== undefined &&
      previousEntry.verifiedMtime === fileMtime
    ) {
      progressDebug(
        progress,
        `Skipping ${download.fileName}: matches file on disk (${previousEntry.hashErrors} recorded API hash mismatch${
          previousEntry.hashErrors === 1 ? "" : "es"
        })`,
      );
      return true;
    }

    // Otherwise re-hash the file on disk to verify it hasn't been corrupted or modified since
    const diskHash = await checksum(download.filePath, progress, stat.size, {
      sha1: Boolean(previousEntry.sha1),
      md5: Boolean(previousEntry.md5),
    });
    totals.checksums++;

    if (
      (!previousEntry.verifiedSize ||
        previousEntry.verifiedSize === stat.size) &&
      ((previousEntry.sha1 && previousEntry.sha1 === diskHash.sha1) ||
        (previousEntry.md5 && previousEntry.md5 === diskHash.md5))
    ) {
      if (fileMtime !== undefined) {
        previousEntry.verifiedMtime = fileMtime;
        previousEntry.verifiedSize = stat.size;
        checksums[cacheKey] = previousEntry;
      }
      progressDebug(
        progress,
        `Skipping ${download.fileName}: matches file on disk (${previousEntry.hashErrors} recorded API hash mismatch${
          previousEntry.hashErrors === 1 ? "" : "es"
        })`,
      );
      return true;
    }
  }

  // Otherwise, record the hash mismatch and compute the actual disk file hash if we were looking at a stale cache entry
  let diskHash = hash;
  if (previousEntry) {
    diskHash = await checksum(download.filePath, progress, stat.size, {
      sha1: true,
      md5: true,
    });
    totals.checksums++;
  }

  const errorCount = (previousEntry?.hashErrors ?? 0) + 1;
  diskHash.hashErrors = errorCount;
  diskHash.verifiedSize = stat.size;
  if (stat.mtime) {
    diskHash.verifiedMtime = stat.mtime.getTime();
  }
  checksums[cacheKey] = diskHash;
  totals.hashErrors = (totals.hashErrors ?? 0) + 1;

  progressDebug(
    progress,
    `Hash verification failed for ${download.fileName} (error #${errorCount})`,
  );
  progressDebug(progress, `calculated: ${diskHash.sha1 ?? ""} ${diskHash.md5 ?? ""}`);
  progressDebug(progress, `expected: ${download.sha1 ?? ""} ${download.md5 ?? ""}`);
  return false;
}

/**
 * Retrieves the cached checksum for a file or computes and caches it.
 * Supports both relative-path keys and legacy fileName keys.
 * Automatically re-hashes if `verifiedSize` is recorded and does not match the current `fileSize` on disk.
 */
async function getOrComputeChecksum(
  download: DownloadInfo,
  fileSize: number,
  fileMtime: number | undefined,
  checksums: Record<string, Checksums>,
  progress: MultiBarWrapper,
  totals: Totals,
  downloadFolder?: string,
): Promise<Checksums> {
  const cacheKey = getChecksumCacheKey(
    download.filePath,
    download.fileName,
    downloadFolder,
  );
  const cached = checksums[cacheKey] ?? checksums[download.fileName];
  const hashOptions = getRequiredHashOptions(download);
  const needSha1 = Boolean(hashOptions.sha1);
  const needMd5 = Boolean(hashOptions.md5);

  const sizeMatchesCache =
    cached?.verifiedSize === undefined || cached.verifiedSize === fileSize;

  if (
    cached &&
    sizeMatchesCache &&
    (!needSha1 || Boolean(cached.sha1)) &&
    (!needMd5 || Boolean(cached.md5))
  ) {
    if (cached.verifiedSize === undefined) {
      cached.verifiedSize = fileSize;
    }
    if (cached.verifiedMtime === undefined && fileMtime !== undefined) {
      cached.verifiedMtime = fileMtime;
    }
    // Migrate legacy fileName key to cacheKey if different
    if (cacheKey !== download.fileName && !checksums[cacheKey]) {
      checksums[cacheKey] = cached;
    }
    return cached;
  }

  const hash = await checksum(
    download.filePath,
    progress,
    fileSize,
    hashOptions,
  );
  totals.checksums++;
  checksums[cacheKey] = {
    ...cached,
    ...hash,
    verifiedSize: fileSize,
    ...(fileMtime !== undefined ? { verifiedMtime: fileMtime } : {}),
  };
  return checksums[cacheKey];
}

/**
 * Adds or updates a single cache entry in the O(1) hash lookup index.
 */
export function addChecksumToHashIndex(
  index: Map<string, Set<string>>,
  cacheKey: string,
  entry?: Checksums,
): void {
  if (!entry) return;
  const addKey = (hashVal: string | undefined) => {
    const clean = hashVal?.trim().toLowerCase();
    if (!clean) return;
    let set = index.get(clean);
    if (!set) {
      set = new Set<string>();
      index.set(clean, set);
    }
    set.add(cacheKey);
  };
  addKey(entry.sha1);
  addKey(entry.md5);
}

/**
 * Builds an O(1) lookup index mapping lowercase hash strings (sha1 and md5)
 * to sets of cache keys in `checksums`.
 */
export function buildChecksumHashIndex(
  checksums: Record<string, Checksums>,
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const [key, entry] of Object.entries(checksums)) {
    addChecksumToHashIndex(index, key, entry);
  }
  return index;
}

const SIDECAR_EXTENSIONS = [".opf", ".jpg", ".jpeg", ".png", ".webp", ".gif"];

function findCandidateCacheKeys(
  download: DownloadInfo,
  checksums: Record<string, Checksums>,
  hashIndex?: Map<string, Set<string>>,
): Set<string> {
  const candidateKeys = new Set<string>();
  if (hashIndex) {
    const expSha1 = download.sha1?.trim().toLowerCase();
    const expMd5 = download.md5?.trim().toLowerCase();
    if (expSha1) {
      hashIndex.get(expSha1)?.forEach((k) => candidateKeys.add(k));
    }
    if (expMd5) {
      hashIndex.get(expMd5)?.forEach((k) => candidateKeys.add(k));
    }
  } else {
    for (const [key, cachedHash] of Object.entries(checksums)) {
      if (isHashVerified(download, cachedHash)) {
        candidateKeys.add(key);
      }
    }
  }
  return candidateKeys;
}

/**
 * Attempts to relocate an already-downloaded file inside `downloadFolder` whose cached
 * hash in `checksums` matches `download` (for instance, when the user toggles
 * `--bundle-folders`, `--product-folders`, or `--human-file-names`), avoiding a redundant network download.
 * Skips candidates that belong to an active target path in `activeTargetPaths` (e.g. under `--no-dedup`).
 * Also relocates any accompanying `.opf` or cover art sidecar files.
 *
 * @returns True if an existing matching file was found and moved to `download.filePath`
 */
export async function tryRelocateExistingFile(
  download: DownloadInfo,
  checksums: Record<string, Checksums>,
  progress: MultiBarWrapper,
  totals: Totals,
  downloadFolder?: string,
  dryRun = false,
  hashIndex?: Map<string, Set<string>>,
  activeTargetPaths?: ReadonlySet<string>,
): Promise<boolean> {
  if (!downloadFolder || (!download.sha1 && !download.md5)) return false;

  const candidateKeys = findCandidateCacheKeys(download, checksums, hashIndex);
  const resolvedFolder = resolveDownloadFolderFast(downloadFolder);
  const targetPath = resolve(download.filePath);

  for (const key of candidateKeys) {
    const cachedHash = checksums[key];
    if (!cachedHash || !isHashVerified(download, cachedHash)) continue;

    const candidatePath = resolve(resolvedFolder, key);
    if (candidatePath.toLowerCase() === targetPath.toLowerCase()) {
      continue;
    }
    if (activeTargetPaths?.has(candidatePath.toLowerCase())) {
      continue;
    }

    try {
      const stat = await Deno.stat(candidatePath);
      if (!stat.isFile) continue;

      if (dryRun) {
        progress.log(
          `[Dry Run] Would relocate existing file: ${key} -> ${download.filePath}`,
        );
        totals.movedFiles = (totals.movedFiles ?? 0) + 1;
        return true;
      }

      await Deno.mkdir(resolve(download.downloadPath), { recursive: true });
      await Deno.rename(candidatePath, targetPath);

      // Also relocate any existing .opf or cover image sidecars next to candidatePath
      const candidateStem = stripFileExtension(candidatePath);
      const targetStem = stripFileExtension(targetPath);
      for (const ext of SIDECAR_EXTENSIONS) {
        const oldSidecar = `${candidateStem}${ext}`;
        const newSidecar = `${targetStem}${ext}`;
        try {
          const sStat = await Deno.stat(oldSidecar);
          if (sStat.isFile) {
            await Deno.rename(oldSidecar, newSidecar).catch(() => {});
          }
        } catch {
          // Sidecar does not exist
        }
      }

      const newKey = getChecksumCacheKey(
        download.filePath,
        download.fileName,
        downloadFolder,
      );
      checksums[newKey] = cachedHash;
      if (newKey !== key) {
        delete checksums[key];
        if (hashIndex) {
          const s1 = cachedHash.sha1?.trim().toLowerCase();
          const m5 = cachedHash.md5?.trim().toLowerCase();
          if (s1) {
            hashIndex.get(s1)?.delete(key);
            hashIndex.get(s1)?.add(newKey);
          }
          if (m5) {
            hashIndex.get(m5)?.delete(key);
            hashIndex.get(m5)?.add(newKey);
          }
        }
      }
      totals.movedFiles = (totals.movedFiles ?? 0) + 1;
      progressDebug(
        progress,
        `Relocated existing verified file: ${key} -> ${newKey}`,
      );
      return true;
    } catch {
      // Candidate file does not exist on disk or could not be moved
    }
  }

  return false;
}

/**
 * Hardlinks (falling back to copying across filesystems) an already-verified identical local file
 * to `download.filePath` when `--link-duplicates` is enabled, avoiding duplicate network downloads
 * and saving disk space under `--no-dedup`.
 */
export async function tryHardlinkExistingFile(
  download: DownloadInfo,
  checksums: Record<string, Checksums>,
  progress: MultiBarWrapper,
  totals: Totals,
  downloadFolder?: string,
  dryRun = false,
  hashIndex?: Map<string, Set<string>>,
): Promise<boolean> {
  if (!downloadFolder || (!download.sha1 && !download.md5)) return false;

  const candidateKeys = findCandidateCacheKeys(download, checksums, hashIndex);
  const resolvedFolder = resolveDownloadFolderFast(downloadFolder);
  const targetPath = resolve(download.filePath);

  for (const key of candidateKeys) {
    const cachedHash = checksums[key];
    if (!cachedHash || !isHashVerified(download, cachedHash)) continue;

    const candidatePath = resolve(resolvedFolder, key);
    if (candidatePath.toLowerCase() === targetPath.toLowerCase()) continue;

    try {
      const stat = await Deno.stat(candidatePath);
      if (!stat.isFile) continue;
      if (
        cachedHash.verifiedSize !== undefined &&
        cachedHash.verifiedSize !== stat.size
      ) {
        continue;
      }

      if (dryRun) {
        progress.log(
          `[Dry Run] Would hardlink duplicate file: ${key} -> ${download.filePath}`,
        );
        totals.linkedFiles = (totals.linkedFiles ?? 0) + 1;
        return true;
      }

      await Deno.mkdir(resolve(download.downloadPath), { recursive: true });
      try {
        await Deno.link(candidatePath, targetPath);
      } catch {
        await Deno.copyFile(candidatePath, targetPath);
      }

      const newKey = getChecksumCacheKey(
        download.filePath,
        download.fileName,
        downloadFolder,
      );
      const entryCopy: Checksums = {
        ...cachedHash,
        verifiedSize: stat.size,
        ...(stat.mtime ? { verifiedMtime: stat.mtime.getTime() } : {}),
      };
      checksums[newKey] = entryCopy;
      if (hashIndex) {
        addChecksumToHashIndex(hashIndex, newKey, entryCopy);
      }
      totals.linkedFiles = (totals.linkedFiles ?? 0) + 1;
      progressDebug(
        progress,
        `Linked duplicate verified file: ${key} -> ${newKey}`,
      );
      return true;
    } catch {
      // Candidate file not accessible
    }
  }

  return false;
}

const latin1Decoder = new TextDecoder("latin1");

/**
 * Validates the binary header and trailer structure of common ebook and archive formats
 * (`.pdf`, `.epub`, `.cbz`, `.zip`, `.gz`, `.tgz`, `.bz2`, `.xz`, `.mobi`, `.prc`)
 * to catch truncated or corrupted files even when API hashes are absent or stale.
 */
export async function validateFileStructure(
  filePath: string,
): Promise<{ valid: boolean; reason?: string }> {
  let file: Deno.FsFile;
  let size: number;
  try {
    const stat = await Deno.stat(filePath);
    if (!stat.isFile) return { valid: false, reason: "Not a regular file" };
    size = stat.size;
    if (size === 0) return { valid: false, reason: "Empty 0-byte file" };
    file = await Deno.open(filePath, { read: true });
  } catch (err) {
    return {
      valid: false,
      reason: err instanceof Error ? err.message : "Cannot open file",
    };
  }

  try {
    const lower = filePath.toLowerCase();
    const readChunk = async (offset: number, length: number) => {
      await file.seek(offset, Deno.SeekMode.Start);
      const buf = new Uint8Array(length);
      let readTotal = 0;
      while (readTotal < length) {
        const n = await file.read(buf.subarray(readTotal));
        if (n === null) break;
        readTotal += n;
      }
      return buf.subarray(0, readTotal);
    };

    if (lower.endsWith(".pdf")) {
      if (size < 16) return { valid: false, reason: "PDF file too small" };
      const head = latin1Decoder.decode(await readChunk(0, Math.min(size, 1024)));
      if (!head.includes("%PDF-")) {
        return { valid: false, reason: "Missing %PDF- header" };
      }
      const tailLen = Math.min(size, 2048);
      const tail = latin1Decoder.decode(await readChunk(size - tailLen, tailLen));
      if (!tail.includes("%%EOF")) {
        return { valid: false, reason: "Missing %%EOF trailer (truncated PDF)" };
      }
      return { valid: true };
    }

    if (
      lower.endsWith(".zip") ||
      lower.endsWith(".epub") ||
      lower.endsWith(".cbz")
    ) {
      if (size < 22) {
        return { valid: false, reason: "ZIP/EPUB/CBZ archive too small" };
      }
      const head = await readChunk(0, 4);
      const isLocalHeader =
        head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
      const isEmptyArchive =
        head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x05 && head[3] === 0x06;
      if (!isLocalHeader && !isEmptyArchive) {
        return { valid: false, reason: "Missing PKZIP magic header" };
      }
      const tailLen = Math.min(size, 65558);
      const tail = await readChunk(size - tailLen, tailLen);
      let foundEocd = false;
      for (let i = tail.length - 22; i >= 0; i--) {
        if (
          tail[i] === 0x50 &&
          tail[i + 1] === 0x4b &&
          tail[i + 2] === 0x05 &&
          tail[i + 3] === 0x06
        ) {
          foundEocd = true;
          break;
        }
      }
      if (!foundEocd) {
        return {
          valid: false,
          reason: "Missing ZIP End of Central Directory record (truncated archive)",
        };
      }
      return { valid: true };
    }

    if (lower.endsWith(".cbr")) {
      if (size < 20) return { valid: false, reason: "CBR archive too small" };
      const head = await readChunk(0, 7);
      const isRar =
        head[0] === 0x52 &&
        head[1] === 0x61 &&
        head[2] === 0x72 &&
        head[3] === 0x21 &&
        head[4] === 0x1a &&
        head[5] === 0x07;
      // Publishers on Humble occasionally upload PKZIP archives with a .cbr extension
      const isPkZip =
        head[0] === 0x50 &&
        head[1] === 0x4b &&
        (head[2] === 0x03 || head[2] === 0x05) &&
        (head[3] === 0x04 || head[3] === 0x06);
      if (!isRar && !isPkZip) {
        return { valid: false, reason: "Missing RAR/ZIP magic header on CBR" };
      }
      return { valid: true };
    }

    if (lower.endsWith(".gz") || lower.endsWith(".tgz")) {
      if (size < 18) return { valid: false, reason: "Gzip archive too small" };
      const head = await readChunk(0, 2);
      if (head[0] !== 0x1f || head[1] !== 0x8b) {
        return { valid: false, reason: "Missing gzip magic header" };
      }
      return { valid: true };
    }

    if (lower.endsWith(".bz2")) {
      if (size < 14) return { valid: false, reason: "Bzip2 archive too small" };
      const head = await readChunk(0, 3);
      if (head[0] !== 0x42 || head[1] !== 0x5a || head[2] !== 0x68) {
        return { valid: false, reason: "Missing BZh header" };
      }
      return { valid: true };
    }

    if (lower.endsWith(".xz")) {
      if (size < 32) return { valid: false, reason: "XZ archive too small" };
      const head = await readChunk(0, 6);
      if (
        head[0] !== 0xfd ||
        head[1] !== 0x37 ||
        head[2] !== 0x7a ||
        head[3] !== 0x58 ||
        head[4] !== 0x5a ||
        head[5] !== 0x00
      ) {
        return { valid: false, reason: "Missing XZ magic header" };
      }
      const tail = await readChunk(size - 2, 2);
      if (tail[0] !== 0x59 || tail[1] !== 0x5a) {
        return { valid: false, reason: "Missing XZ YZ stream footer" };
      }
      return { valid: true };
    }

    if (lower.endsWith(".mobi") || lower.endsWith(".prc")) {
      if (size < 68) return { valid: false, reason: "MOBI file too small" };
      const ident = latin1Decoder.decode(await readChunk(60, 8));
      if (ident !== "BOOKMOBI" && ident !== "TEXtREAd") {
        return { valid: false, reason: "Missing BOOKMOBI/PalmDOC header" };
      }
      return { valid: true };
    }

    return { valid: true };
  } finally {
    file.close();
  }
}

/**
 * Verifies if calculated hash matches expected download sha1 or md5.
 * Handles cases where Humble Bundle API swaps sha1 and md5 fields or provides
 * an outdated sha1 while md5 matches (or vice versa).
 */
export function isHashVerified(download: DownloadInfo, hash: Checksums): boolean {
  const expSha1 = download.sha1?.trim().toLowerCase();
  const expMd5 = download.md5?.trim().toLowerCase();
  const calcSha1 = hash.sha1?.trim().toLowerCase();
  const calcMd5 = hash.md5?.trim().toLowerCase();

  // Direct match on SHA-1 or MD5
  if (expSha1 && calcSha1 && expSha1 === calcSha1) return true;
  if (expMd5 && calcMd5 && expMd5 === calcMd5) return true;

  // Cross-match in case Humble Bundle stored MD5 in the sha1 field or SHA-1 in the md5 field
  if (expSha1 && calcMd5 && expSha1 === calcMd5) return true;
  if (expMd5 && calcSha1 && expMd5 === calcSha1) return true;

  return false;
}
