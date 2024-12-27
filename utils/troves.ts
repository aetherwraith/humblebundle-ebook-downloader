import { yellow } from "@std/fmt/colors";
import { basename, resolve } from "@std/path";
import type { MultiBar } from "cli-progress";
import sanitizeFilename from "sanitize-filename";

import { DownloadInfo, Options, Queues, Totals } from "../types/general.ts";
import { Trove } from "../types/trove.ts";
import { getTroveURL } from "./web.ts";

export async function filterTroves(
  troves: Trove[],
  options: Options,
  totals: Totals,
  progress: MultiBar,
  queues: Queues,
) {
  progress.log(
    `${
      yellow(
        troves.length.toString(),
      )
    } bundles containing downloadable items`,
  );
  const downloads: DownloadInfo[] = [];

  options.platform.forEach((platform) => {
    troves.forEach((trove) => {
      if (Object.hasOwn(trove.downloads, platform)) {
        queues.orderInfo.add(async () => {
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
            date: new Date(trove.downloads[platform].uploaded_at || trove.downloads[platform].timestamp * 1000 || trove["date-added"] * 1000),
            file_size: trove.downloads[platform].file_size,
          });
        });
      }
    });
  });
  await queues.orderInfo.done();
  totals.filteredDownloads = downloads.length;
  return downloads.sort((a, b) => a.name.localeCompare(b.name));
}
