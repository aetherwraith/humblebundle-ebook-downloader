import { yellow } from "@std/fmt/colors";
import { basename, resolve } from "@std/path";
import sanitizeFilename from "sanitize-filename";
import { MultiBar } from "./progress.ts";

import { DownloadInfo, Options, Queues, Totals } from "../types/general.ts";
import { Trove } from "../types/trove.ts";
import { getTroveURL } from "./web.ts";

/**
 * Filter troves to create a list of downloadable items
 */
export async function filterTroves(
  troves: Trove[],
  options: Options,
  totals: Totals,
  progress: MultiBar,
  queues: Queues,
): Promise<DownloadInfo[]> {
  progress.log(
    `${yellow(troves.length.toString())} troves containing downloadable items`,
  );
  const downloads: DownloadInfo[] = [];

  for (const platform of options.platform) {
    for (const trove of troves) {
      if (Object.hasOwn(trove.downloads, platform)) {
        queues.orderInfo.add(async () => {
          try {
            const url = await getTroveURL(
              trove.downloads[platform].machine_name,
              trove.downloads[platform].url.web,
              options,
            );
            const fileName = sanitizeFilename(basename(url.pathname));
            const downloadPath = resolve(
              options.downloadFolder,
              sanitizeFilename(trove["human-name"]),
            );
            const filePath = resolve(downloadPath, fileName);

            // Calculate the date using various available sources
            const timestamp = trove.downloads[platform].uploaded_at ||
              trove.downloads[platform].timestamp * 1000 ||
              trove["date-added"] * 1000;

            downloads.push({
              bundle: trove["human-name"],
              name: trove["human-name"],
              machineName: trove.downloads[platform].machine_name,
              fileName,
              downloadPath,
              filePath,
              url,
              sha1: trove.downloads[platform].sha1,
              md5: trove.downloads[platform].md5,
              structName: fileName,
              date: new Date(timestamp),
              file_size: trove.downloads[platform].file_size,
            });
          } catch (err) {
            progress.log(
              `Error processing trove item: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        });
      }
    }
  }

  await queues.orderInfo.done();
  totals.filteredDownloads = downloads.length;

  // Sort by file size in descending order (largest first)
  // With name as a fallback for files of the same size
  return downloads.sort((a, b) => {
    // First compare by file size (descending)
    if (a.file_size !== b.file_size) {
      return (b.file_size ?? 0) - (a.file_size ?? 0);
    }
    // Fall back to name for files of the same size (ascending)
    return a.name.localeCompare(b.name);
  });
}
