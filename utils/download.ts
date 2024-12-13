import { retry, RetryError } from "@std/async";
import { cyan } from "@std/fmt/colors";
import { resolve } from "@std/path/resolve";
import type { MultiBar, SingleBar } from "cli-progress";
import { checkSignatureMatch, computeFileHash } from "./checksums.ts";
import { retryOptions } from "./constants.ts";
import { DownloadInfo } from "./orders.ts";
import { StreamProgress } from "./streamProgress.ts";
import { Checksums, Queues, Totals } from "./types.ts";

export async function downloadItem(
  download: DownloadInfo,
  checksums: Record<string, Checksums>,
  progress: MultiBar,
  downloadProgress: SingleBar,
  queues: Queues,
  totals: Totals,
): Promise<void> {
  if (
    !(await checkSignatureMatch(download, checksums, progress, totals))
  ) {
    totals.downloads++;

    await retry(
      async () =>
        await doDownload(download, progress, checksums).catch((err) => {
          if (err instanceof RetryError) {
            progress.log("Retry error :", err.message);
            progress.log("Error cause :", err.cause);
            throw err;
          }
        }),
      retryOptions,
    );
  }
  totals.doneDownloads++;
  downloadProgress.increment();
}

export async function doDownload(
  download: DownloadInfo,
  progress: MultiBar,
  checksums: Record<string, Checksums>,
) {
  const filePath = resolve(download.filePath);
  await Deno.mkdir(resolve(download.downloadPath), { recursive: true });
  const saveFile = await Deno.open(filePath, {
    read: true,
    write: true,
    create: true,
  });
  const fileStream = saveFile.writable;
  const req = await fetch(download.url);
  const size = Number(req.headers.get("content-length"));
  const downloadStream = req.body?.pipeThrough(
    new StreamProgress(size, download.filePath, progress, "Downloading", cyan),
  );
  const [writeStream, checksumStream] = downloadStream.tee();
  const [hash, _] = await Promise.all([
    computeFileHash(checksumStream),
    writeStream.pipeTo(fileStream),
  ]);
  checksums[download.fileName] = hash;
}

export function downloadItems(
  filteredBundles: DownloadInfo[],
  progress: MultiBar,
  checksums: Record<string, Checksums>,
  queues: Queues,
  totals: Totals,
) {
  const downloadProgress = progress.create(filteredBundles.length, 0, {
    file: "Download Queue",
  });
  for (const download of filteredBundles) {
    queues.downloads.add(async () =>
      downloadItem(
        download,
        checksums,
        progress,
        downloadProgress,
        queues,
        totals,
      )
    );
  }
}
