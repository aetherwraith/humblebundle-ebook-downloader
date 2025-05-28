import { cyan } from "@std/fmt/colors";
import { resolve } from "@std/path";
import { checkSignatureMatch, computeFileHash } from "./checksums.ts";
import { isNetworkAvailable, waitForNetworkAvailability } from "./network.ts";
import { StreamProgress } from "./streamProgress.ts";
import { MultiBar, SingleBar } from "./progress.ts";

import { DownloadInfo, Queues, Totals } from "../types/general.ts";
import { Checksums } from "../types/bundle.ts";

/**
 * Retry a function with exponential backoff
 */
async function retry<T>(
  fn: () => Promise<T>,
  options: { maxAttempts: number; minTimeout: number; multiplier: number },
): Promise<T> {
  let attempt = 0;
  let lastError: Error | null = null;

  while (attempt < options.maxAttempts) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      attempt++;
      if (attempt >= options.maxAttempts) break;

      // Calculate backoff delay
      const delay = options.minTimeout *
        Math.pow(options.multiplier, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError ?? new Error("Retry failed");
}

/**
 * Download an item if needed
 */
export async function downloadItem(
  download: DownloadInfo,
  checksums: Record<string, Checksums>,
  progress: MultiBar,
  downloadProgress: SingleBar,
  totals: Totals,
): Promise<void> {
  if (!(await checkSignatureMatch(download, checksums, progress, totals))) {
    totals.downloads++;

    await retry(
      async () => await doDownload(download, progress, checksums),
      { maxAttempts: 3, minTimeout: 1000, multiplier: 2 },
    );
  }
  totals.doneDownloads++;
  downloadProgress.increment();
}

/**
 * Download a file from a URL
 */
export async function doDownload(
  download: DownloadInfo,
  progress: MultiBar,
  checksums: Record<string, Checksums>,
): Promise<void> {
  // Check if network is available before proceeding
  if (!isNetworkAvailable()) {
    progress.log(
      `Network connection unavailable. Waiting before downloading ${download.fileName}...`,
    );
    const networkRestored = await waitForNetworkAvailability(300000, progress); // 5 minute timeout
    if (!networkRestored) {
      throw new Error(
        `Cannot download ${download.fileName}: Network connection unavailable`,
      );
    }
  }

  const filePath = resolve(download.filePath);
  await Deno.mkdir(resolve(download.downloadPath), { recursive: true });
  const saveFile = await Deno.open(filePath, {
    read: true,
    write: true,
    create: true,
    truncate: true,
  });
  const fileStream = saveFile.writable;

  // Use Deno's native AbortController for request cancellation support
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000); // 60 second timeout

  try {
    const req = await fetch(download.url.toString(), {
      signal: controller.signal,
      headers: {
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
      },
    });

    if (!req.ok || !req.body) {
      throw new Error(`Failed to fetch: ${req.status} ${req.statusText}`);
    }

    const size = Number(req.headers.get("content-length"));
    const downloadStream = req.body.pipeThrough(
      new StreamProgress(
        size,
        download.filePath,
        progress,
        "Downloading",
        cyan,
      ),
    );

    // Use more efficient stream handling
    const [writeStream, checksumStream] = downloadStream.tee();
    const [hash, _] = await Promise.all([
      computeFileHash(checksumStream),
      writeStream.pipeTo(fileStream).catch((err) => {
        controller.abort(); // Abort fetch if write fails
        throw err;
      }),
    ]);

    checksums[download.fileName] = hash;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(
        `Download timed out after 60 seconds: ${download.fileName}`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    saveFile.close();
  }
}

/**
 * Queue downloads for processing
 */
export function downloadItems(
  filteredBundles: DownloadInfo[],
  progress: MultiBar,
  checksums: Record<string, Checksums>,
  queues: Queues,
  totals: Totals,
): void {
  const downloadProgress = progress.create(filteredBundles.length, 0, {
    file: "Download Queue",
  });

  for (const download of filteredBundles) {
    queues.downloads.add(() =>
      downloadItem(
        download,
        checksums,
        progress,
        downloadProgress,
        totals,
      )
    );
  }
}
