import { retry, RetryError } from "@std/async";
import { cyan } from "@std/fmt/colors";
import { resolve } from "@std/path/resolve";
import { MultiBarWrapper } from "./progressWrapper.ts";
import { checkSignatureMatch, computeFileHash } from "./checksums.ts";
import { retryOptions } from "./constants.ts";
import { StreamProgress } from "./streamProgress.ts";

import { DownloadInfo, Options, Queues, Totals } from "../types/general.ts";
import { Checksums } from "../types/bundle.ts";
import { refreshDownloadUrl } from "./web.ts";



export async function doDownload(
  download: DownloadInfo,
  progress: MultiBarWrapper,
  checksums: Record<string, Checksums>,
  signal?: AbortSignal,
  options?: Options,
) {
  const filePath = resolve(download.filePath);
  await Deno.mkdir(resolve(download.downloadPath), { recursive: true });
  const saveFile = await Deno.open(filePath, {
    read: true,
    write: true,
    create: true,
  });
  const fileStream = saveFile.writable;
  let req = await fetch(download.url, { signal });
  
  if (!req.ok) {
    if ((req.status === 403 || req.status === 401) && options) {
      progress.log(`URL expired for ${download.fileName}, refreshing...`);
      download.url = await refreshDownloadUrl(download, options);
      req = await fetch(download.url, { signal });
      if (!req.ok) {
        throw new Error(`Failed to download after refresh: HTTP ${req.status} ${req.statusText}`);
      }
    } else {
      throw new Error(`HTTP ${req.status}: ${req.statusText}`);
    }
  }

  const size = Number(req.headers.get("content-length"));
  if (!req.body) {
    throw new Error("Response body is empty");
  }
  const downloadStream = req.body.pipeThrough(
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
  progress: MultiBarWrapper,
  checksums: Record<string, Checksums>,
  queues: Queues,
  totals: Totals,
  signal?: AbortSignal,
  options?: Options,
) {
  const downloadProgress = progress.create(filteredBundles.length, 0, {
    file: "Download Queue",
  });
  for (const download of filteredBundles) {
    queues.fileCheck.add(async () => {
      if (signal?.aborted) return;

      const match = await checkSignatureMatch(download, checksums, progress, totals);
      if (signal?.aborted) return;

      if (!match) {
        totals.downloads++;
        queues.downloads.add(async () => {
          if (signal?.aborted) return;
          
          await retry(
            async () =>
              await doDownload(download, progress, checksums, signal, options).catch((err) => {
                progress.log("Error downloading ", download.fileName);
                progress.log(err.message);
                if (err instanceof RetryError) {
                  progress.log("Retry error :", err.message);
                  progress.log("Error cause :", err.cause);
                }
                throw err;
              }),
            retryOptions,
          );
          
          totals.doneDownloads++;
          downloadProgress.increment();
        });
      } else {
        totals.doneDownloads++;
        downloadProgress.increment();
      }
    });
  }
}
