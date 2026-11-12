import { retry, RetryError } from "@std/async";
import { cyan } from "@std/fmt/colors";
import { resolve } from "@std/path/resolve";
import { MultiBarWrapper, progressDebug } from "./progressWrapper.ts";
import {
  addChecksumToHashIndex,
  buildChecksumHashIndex,
  checkSignatureMatch,
  checksum,
  computeFileHash,
  getChecksumCacheKey,
  getRequiredHashOptions,
  isHashVerified,
  tryHardlinkExistingFile,
  tryRelocateExistingFile,
  validateFileStructure,
} from "./checksums.ts";
import { cacheFileName, retryOptions } from "./constants.ts";
import {
  downloadCoverArt,
  ensureDirCached,
  extractArchive,
  writeJsonFile,
  writeOpfSidecar,
} from "./fileUtils.ts";
import { parseSize } from "./generic.ts";
import { globalBandwidthLimiter, StreamProgress } from "./streamProgress.ts";

import { DownloadInfo, Options, Queues, Totals } from "../types/general.ts";
import { Checksums } from "../types/bundle.ts";
import { getTroveURL, refreshDownloadUrl } from "./web.ts";

// Track in-flight temporary .part files so SIGINT/SIGTERM can clean them up synchronously
const activePartFiles = new Set<string>();

/**
 * Returns the read-only set of currently active `.part` file paths.
 */
export function getActivePartFiles(): ReadonlySet<string> {
  return activePartFiles;
}

/**
 * Removes any currently active `.part` files synchronously (called on SIGINT/SIGTERM).
 */
export function cleanupActivePartFilesSync(): void {
  for (const partPath of activePartFiles) {
    try {
      Deno.removeSync(partPath);
    } catch {
      // Ignore if already removed or renamed
    }
  }
  activePartFiles.clear();
}

/**
 * Downloads a single file from Humble Bundle to a temporary `.part` file,
 * tracks stream progress, calculates and verifies checksums on the fly,
 * and atomically renames the file to its final path on completion.
 * If authentication on the URL has expired (401/403), attempts to refresh the URL.
 *
 * @param download Target download item
 * @param progress MultiBarWrapper progress logger
 * @param checksums Checksum cache dictionary to update with calculated hash
 * @param signal Optional AbortSignal to cancel download
 * @param options Runtime options for URL refreshing
 * @param totals Optional Totals counter
 */
export async function doDownload(
  download: DownloadInfo,
  progress: MultiBarWrapper,
  checksums: Record<string, Checksums>,
  signal?: AbortSignal,
  options?: Options,
  totals?: Totals,
): Promise<void> {
  // Sign Vault/Bundle URLs lazily right before downloading
  if (download.webFilename && options) {
    download.url = download.entitlementId
      ? await refreshDownloadUrl(download, options)
      : await getTroveURL(
        download.machineName,
        download.webFilename,
        options,
        download.subProductId,
      );
  }

  const filePath = resolve(download.filePath);
  const resumePartPath = `${filePath}.part`;
  await ensureDirCached(download.downloadPath);

  // Check if an interrupted .part file already exists for HTTP Range resume
  let existingPartSize = 0;
  try {
    const partStat = await Deno.stat(resumePartPath);
    if (partStat.isFile && partStat.size > 0) {
      existingPartSize = partStat.size;
    }
  } catch {
    // No existing .part file
  }

  const fetchWithRange = (url: URL, offset: number) => {
    const headers = new Headers();
    if (offset > 0) {
      headers.set("Range", `bytes=${offset}-`);
    }
    return fetch(url, { signal, headers });
  };

  let req = await fetchWithRange(download.url, existingPartSize);

  if (req.status === 416 && existingPartSize > 0) {
    // Range Not Satisfiable: remove stale .part and retry from 0
    await Deno.remove(resumePartPath).catch(() => {});
    existingPartSize = 0;
    req = await fetchWithRange(download.url, 0);
  }

  if (!req.ok) {
    if (
      (req.status === 403 || req.status === 401 || req.status === 404) &&
      options
    ) {
      progressDebug(progress, `URL expired for ${download.fileName}, refreshing...`);
      download.url = download.webFilename && !download.entitlementId
        ? await getTroveURL(
          download.machineName,
          download.webFilename,
          options,
          download.subProductId,
          true,
        )
        : await refreshDownloadUrl(download, options, true);
      req = await fetchWithRange(download.url, existingPartSize);
      if (!req.ok) {
        throw new Error(
          `Failed to download after refresh: HTTP ${req.status} ${req.statusText}`,
        );
      }
    } else {
      throw new Error(`HTTP ${req.status}: ${req.statusText}`);
    }
  }

  const isPartial = req.status === 206 && existingPartSize > 0;
  const contentLength = Number(req.headers.get("content-length")) || 0;
  const expectedTotalSize = isPartial
    ? existingPartSize + contentLength
    : contentLength;

  if (!req.body) {
    throw new Error("Response body is empty");
  }

  // Use the resumable .part path unless another worker already has it open in activePartFiles
  const partPath = !activePartFiles.has(resumePartPath)
    ? resumePartPath
    : `${filePath}.${crypto.randomUUID()}.part`;
  activePartFiles.add(partPath);

  const saveFile = await Deno.open(
    partPath,
    isPartial && partPath === resumePartPath
      ? { read: true, write: true, create: true, append: true }
      : { read: true, write: true, create: true, truncate: true },
  );

  // Only compute the hash algorithm(s) actually needed by `download` (handling swapped lengths)
  const hashOptions = getRequiredHashOptions(download);

  try {
    const fileStream = saveFile.writable;
    const downloadStream = req.body.pipeThrough(
      new StreamProgress(
        contentLength,
        download.filePath,
        progress,
        isPartial ? "Resuming" : "Downloading",
        cyan,
        globalBandwidthLimiter,
      ),
    );

    let hash: Checksums;
    if (isPartial && partPath === resumePartPath) {
      await downloadStream.pipeTo(fileStream);
      const fullFile = await Deno.open(partPath, { read: true });
      hash = await computeFileHash(fullFile.readable, hashOptions);
    } else {
      const [writeStream, checksumStream] = downloadStream.tee();
      const [streamHash] = await Promise.all([
        computeFileHash(checksumStream, hashOptions),
        writeStream.pipeTo(fileStream),
      ]);
      hash = streamHash;
    }

    const stat = await Deno.stat(partPath);
    if (expectedTotalSize > 0 && stat.size !== expectedTotalSize) {
      throw new Error(
        `Incomplete download for ${download.fileName}: received ${stat.size} of ${expectedTotalSize} bytes`,
      );
    }

    const cacheKey = getChecksumCacheKey(
      download.filePath,
      download.fileName,
      options?.downloadFolder,
    );
    const previousErrors =
      (checksums[cacheKey]?.hashErrors ??
        checksums[download.fileName]?.hashErrors) ?? 0;

    hash.verifiedSize = stat.size;
    if ((download.sha1 || download.md5) && !isHashVerified(download, hash)) {
      const errorCount = previousErrors + 1;
      hash.hashErrors = errorCount;
      if (totals) {
        totals.hashErrors = (totals.hashErrors ?? 0) + 1;
      }
      progressDebug(
        progress,
        `Warning: API checksum mismatch #${errorCount} for ${download.fileName} (calculated sha1=${hash.sha1 ?? "none"} md5=${hash.md5 ?? "none"}, API expected sha1=${download.sha1 ?? "none"} md5=${download.md5 ?? "none"}). Keeping downloaded file.`,
      );
    }

    await Deno.rename(partPath, filePath);
    activePartFiles.delete(partPath);
    if (options?.preserveMtime && !isNaN(download.date.getTime())) {
      await Deno.utime(filePath, download.date, download.date).catch(() => {});
      hash.verifiedMtime = download.date.getTime();
    } else if (stat.mtime) {
      hash.verifiedMtime = stat.mtime.getTime();
    }
    checksums[cacheKey] = hash;
    if (options?.covers) {
      await downloadCoverArt(download, true, signal);
    }
    if (options?.opf) {
      await writeOpfSidecar(download, true);
    }
    if (options?.extract) {
      await extractArchive(filePath, true, progress);
    }
  } catch (err) {
    try {
      saveFile.close();
    } catch {
      // Already closed by writable stream
    }
    // Remove non-resumable unique temp files; keep resumePartPath if partial bytes were written so retry can resume
    if (partPath !== resumePartPath) {
      await Deno.remove(partPath).catch(() => {});
    }
    activePartFiles.delete(partPath);
    throw err;
  }
}

/**
 * Enqueues a list of filtered downloads into parallel processing queues.
 * Verifies local checksums before queuing actual network downloads, and applies retry logic.
 *
 * @param filteredBundles Array of items to download
 * @param progress MultiBarWrapper progress manager
 * @param checksums Checksums dictionary
 * @param queues Worker queues
 * @param totals Statistics tracker
 * @param signal Optional AbortSignal
 * @param options Runtime options
 */
export function downloadItems(
  filteredBundles: DownloadInfo[],
  progress: MultiBarWrapper,
  checksums: Record<string, Checksums>,
  queues: Queues,
  totals: Totals,
  signal?: AbortSignal,
  options?: Options,
): void {
  globalBandwidthLimiter.setRate(parseSize(options?.rateLimit) ?? 0);
  const downloadProgress = progress.create(filteredBundles.length, 0, {
    file: "Download Queue",
  });
  const hashIndex = buildChecksumHashIndex(checksums);
  const activeTargetPaths = new Set(
    filteredBundles.map((d) => resolve(d.filePath).toLowerCase()),
  );
  let pendingCacheUpdates = 0;
  let flushInFlight = false;
  const maybeFlushChecksums = async () => {
    pendingCacheUpdates++;
    if (
      options?.downloadFolder &&
      !options.dryRun &&
      pendingCacheUpdates >= 20 &&
      !flushInFlight
    ) {
      pendingCacheUpdates = 0;
      flushInFlight = true;
      try {
        await writeJsonFile(options.downloadFolder, cacheFileName, checksums);
      } catch {
        // Ignore transient checkpoint errors
      } finally {
        flushInFlight = false;
      }
    }
  };

  for (const download of filteredBundles) {
    queues.fileCheck.add(async () => {
      if (signal?.aborted) return;

      const cacheKey = getChecksumCacheKey(
        download.filePath,
        download.fileName,
        options?.downloadFolder,
      );
      const prevChecksumsCount = totals.checksums;
      let match = await checkSignatureMatch(
        download,
        checksums,
        progress,
        totals,
        options?.downloadFolder,
      );
      if (totals.checksums > prevChecksumsCount) {
        addChecksumToHashIndex(hashIndex, cacheKey, checksums[cacheKey]);
        await maybeFlushChecksums();
      }
      if (signal?.aborted) return;

      if (!match) {
        // Check if the file already exists at an orphaned old path in downloadFolder
        match = await tryRelocateExistingFile(
          download,
          checksums,
          progress,
          totals,
          options?.downloadFolder,
          options?.dryRun,
          hashIndex,
          activeTargetPaths,
        );
      }

      if (!match && options?.linkDuplicates) {
        match = await tryHardlinkExistingFile(
          download,
          checksums,
          progress,
          totals,
          options?.downloadFolder,
          options?.dryRun,
          hashIndex,
        );
      }

      if (!match) {
        totals.downloads++;
        if (options?.dryRun) {
          progress.log(`[Dry Run] Would download: ${download.filePath}`);
          totals.doneDownloads++;
          downloadProgress.increment();
          return;
        }
        queues.downloads.add(async () => {
          if (signal?.aborted) return;

          try {
            await retry(
              async () =>
                await doDownload(
                  download,
                  progress,
                  checksums,
                  signal,
                  options,
                  totals,
                ).catch((err) => {
                  progressDebug(progress, "Error downloading ", download.fileName);
                  progressDebug(progress, err.message);
                  if (err instanceof RetryError) {
                    progressDebug(progress, "Retry error :", err.message);
                    progressDebug(progress, "Error cause :", err.cause);
                  }
                  throw err;
                }),
              retryOptions,
            );
            addChecksumToHashIndex(hashIndex, cacheKey, checksums[cacheKey]);
            totals.doneDownloads++;
            await maybeFlushChecksums();
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            progress.log(
              `Failed to download ${download.fileName} after ${retryOptions.maxAttempts} attempts: ${errorMsg}`,
            );
            if (!totals.failedDownloads) {
              totals.failedDownloads = [];
            }
            totals.failedDownloads.push({
              fileName: download.fileName,
              bundle: download.bundle,
              error: errorMsg,
            });
          } finally {
            downloadProgress.increment();
          }
        });
      } else {
        if (!options?.dryRun) {
          if (options?.covers) {
            await downloadCoverArt(download, false, signal).catch(() => {});
          }
          if (options?.opf) {
            await writeOpfSidecar(download, false).catch(() => {});
          }
          if (options?.extract) {
            await extractArchive(download.filePath, false, progress).catch(
              () => {},
            );
          }
        }
        totals.doneDownloads++;
        downloadProgress.increment();
      }
    });
  }
}

/**
 * Performs a deep integrity check (`verify` / `repair` command) across all filtered items by
 * re-computing hashes directly from disk (bypassing cached hashes) and reporting
 * any missing, truncated, or mismatched files. When `repair` is true, automatically
 * queues missing or corrupted files for re-download.
 */
export function verifyItems(
  filteredBundles: DownloadInfo[],
  progress: MultiBarWrapper,
  checksums: Record<string, Checksums>,
  queues: Queues,
  totals: Totals,
  signal?: AbortSignal,
  options?: Options,
  repair = false,
): void {
  globalBandwidthLimiter.setRate(parseSize(options?.rateLimit) ?? 0);
  const verifyProgress = progress.create(filteredBundles.length, 0, {
    file: repair ? "Repair Queue" : "Verify Queue",
  });

  const enqueueRepairDownload = (download: DownloadInfo, reason: string) => {
    totals.downloads++;
    if (options?.dryRun) {
      progress.log(
        `[Dry Run] Would repair (${reason}): ${download.filePath}`,
      );
      totals.doneDownloads++;
      verifyProgress.increment();
      return;
    }
    progressDebug(
      progress,
      `Queueing repair download for ${download.fileName} (${reason})`,
    );
    queues.downloads.add(async () => {
      if (signal?.aborted) return;
      try {
        await retry(
          async () =>
            await doDownload(
              download,
              progress,
              checksums,
              signal,
              options,
              totals,
            ),
          retryOptions,
        );
        totals.doneDownloads++;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        progress.log(
          `Failed to repair ${download.fileName} after ${retryOptions.maxAttempts} attempts: ${errorMsg}`,
        );
        totals.failedDownloads = totals.failedDownloads ?? [];
        totals.failedDownloads.push({
          fileName: download.fileName,
          bundle: download.bundle,
          error: errorMsg,
        });
      } finally {
        verifyProgress.increment();
      }
    });
  };

  for (const download of filteredBundles) {
    queues.fileCheck.add(async () => {
      if (signal?.aborted) return;

      let stat: Deno.FileInfo;
      try {
        stat = await Deno.stat(download.filePath);
        if (!stat.isFile) {
          throw new Error("Not a regular file");
        }
      } catch {
        progressDebug(progress, `Missing file on disk: ${download.filePath}`);
        if (repair) {
          enqueueRepairDownload(download, "missing on disk");
        } else {
          totals.failedDownloads = totals.failedDownloads ?? [];
          totals.failedDownloads.push({
            fileName: download.fileName,
            bundle: download.bundle,
            error: "Missing on disk",
          });
          verifyProgress.increment();
        }
        return;
      }

      const hasExpectedHash = Boolean(download.sha1 || download.md5);
      const diskHash = await checksum(
        download.filePath,
        progress,
        stat.size,
        getRequiredHashOptions(download),
      );
      totals.checksums++;

      const cacheKey = getChecksumCacheKey(
        download.filePath,
        download.fileName,
        options?.downloadFolder,
      );
      const existing = checksums[cacheKey] ?? checksums[download.fileName];
      checksums[cacheKey] = {
        ...existing,
        ...diskHash,
        verifiedSize: stat.size,
        ...(stat.mtime ? { verifiedMtime: stat.mtime.getTime() } : {}),
      };

      if (hasExpectedHash && !isHashVerified(download, diskHash)) {
        totals.hashErrors = (totals.hashErrors ?? 0) + 1;
        checksums[cacheKey].hashErrors = (existing?.hashErrors ?? 0) + 1;
        progressDebug(
          progress,
          `Hash mismatch for ${download.fileName}: disk sha1=${diskHash.sha1 ?? "none"} md5=${diskHash.md5 ?? "none"}`,
        );
        if (repair) {
          enqueueRepairDownload(download, "checksum mismatch");
          return;
        }
        totals.failedDownloads = totals.failedDownloads ?? [];
        totals.failedDownloads.push({
          fileName: download.fileName,
          bundle: download.bundle,
          error: "Checksum mismatch against Humble Bundle API",
        });
        verifyProgress.increment();
        return;
      }

      if (options?.deep || !hasExpectedHash) {
        const structure = await validateFileStructure(download.filePath);
        if (!structure.valid) {
          const reason = structure.reason ?? "Corrupt file structure";
          progressDebug(
            progress,
            `Structural validation failed for ${download.fileName}: ${reason}`,
          );
          if (repair) {
            enqueueRepairDownload(download, reason);
            return;
          }
          totals.failedDownloads = totals.failedDownloads ?? [];
          totals.failedDownloads.push({
            fileName: download.fileName,
            bundle: download.bundle,
            error: reason,
          });
          verifyProgress.increment();
          return;
        }
      }

      totals.doneDownloads++;
      verifyProgress.increment();
    });
  }
}
