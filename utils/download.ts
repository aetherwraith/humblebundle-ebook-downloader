import { DownloadInfo } from "./orders.ts";
import { checkSignatureMatch, computeFileHash } from "./checksums.ts";
import { Checksums, Totals } from "./types.ts";
import { resolve } from "@std/path/resolve";
import { StreamProgress } from "./streamProgress.ts";
import { cyan } from "@std/fmt/colors";
import type { MultiBar, SingleBar } from "cli-progress";

export async function downloadItem(
  download: DownloadInfo,
  checksums: Record<string, Checksums>,
  progress: MultiBar,
  downloadProgress: SingleBar,
  queues,
  totals: Totals,
): Promise<void> {
  if (
    await queues.fileCheck.add(() =>
      checkSignatureMatch(download, checksums, progress)
    )
  ) {
    totals.doneDownloads++;
    downloadProgress.increment();
  } else {
    totals.downloads++;
    queues.downloads.add(() =>
      doDownload(download, progress, checksums, downloadProgress, totals)
    ).catch((_: unknown) =>
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

export async function doDownload(
  download: DownloadInfo,
  progress: MultiBar,
  checksums: Record<string, Checksums>,
  downloadProgress: SingleBar,
  totals: Totals,
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
  const size = Number(req.headers.get("content-length"))
  const downloadStream = req.body?.pipeThrough(
    new StreamProgress(size, download.filePath, progress, "Downloading", cyan),
  );
  const [writeStream, checksumStream] = downloadStream.tee();
  const [hash, _] = await Promise.all([
    computeFileHash(checksumStream),
    writeStream.pipeTo(fileStream),
  ]);
  checksums[download.fileName] = hash;
  totals.doneDownloads++;
  downloadProgress.increment();
}
