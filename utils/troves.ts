import { yellow } from "@std/fmt/colors";
import { basename, extname, resolve } from "@std/path";
import { MultiBarWrapper } from "./progressWrapper.ts";
import {
  compileItemFilters,
  resolveOutputTemplate,
  sanitizeFilename,
  sortDownloads,
} from "./generic.ts";

import { DownloadInfo, Options, Totals } from "../types/general.ts";
import { Trove } from "../types/trove.ts";

/**
 * Filters Humble Trove catalogue items by supported platforms and formats them
 * into DownloadInfo items. Signed download URLs are resolved lazily at download time
 * (via `webFilename`) to avoid unnecessary API calls for already-verified local files.
 *
 * @param troves Array of Trove catalog items
 * @param options Runtime options (platform, downloadFolder)
 * @param totals Statistics tracker
 * @param progress MultiBarWrapper progress logger
 * @returns Sorted array of DownloadInfo items
 */
const TROVE_SUFFIX_RE = /_trove$/i;

export function filterTroves(
  troves: Trove[],
  options: Options,
  totals: Totals,
  progress: MultiBarWrapper,
): DownloadInfo[] {
  progress.log(
    `${
      yellow(
        troves.length.toString(),
      )
    } bundles containing downloadable items`,
  );
  const downloads: DownloadInfo[] = [];

  const platforms = [...new Set(options.platform ?? [])];
  const filters = compileItemFilters(options);
  const resolvedDownloadFolder = resolve(options.downloadFolder);

  for (const trove of troves) {
    if (
      !filters.matchesBundleKey(trove.machine_name) ||
      !filters.matchesText(trove["human-name"], trove.machine_name)
    ) {
      continue;
    }

    const publisher = trove.publishers?.[0]?.["publisher-name"] ??
      trove.developers?.[0]?.["developer-name"];
    const sanitizedTroveName = options.outputTemplate
      ? ""
      : sanitizeFilename(trove["human-name"]);
    const subProductId = trove.subProductId ??
      trove.machine_name.replace(TROVE_SUFFIX_RE, "");

    for (const platform of platforms) {
      if (!Object.hasOwn(trove.downloads, platform)) continue;
      const download = trove.downloads[platform];
      if (!download) continue;
      if (!filters.matchesSize(download.file_size)) continue;

      const rawTimestamp = download.uploaded_at || download.timestamp ||
        trove["date-added"];
      const timestampMs = rawTimestamp
        ? (rawTimestamp < 1e11 ? rawTimestamp * 1000 : rawTimestamp)
        : 0;
      const itemDate = new Date(timestampMs);
      if (isNaN(itemDate.getTime())) continue;
      if (!filters.matchesDate(itemDate)) continue;

      const placeholderUrl = new URL(
        download.url.web,
        "https://www.humblebundle.com/",
      );
      const rawBaseName = decodeURIComponent(basename(placeholderUrl.pathname));

      let fileName: string;
      let downloadPath: string;
      let filePath: string;
      if (options.outputTemplate) {
        const ext = extname(rawBaseName);
        const isoDate = itemDate.toISOString().split("T")[0];
        const resolved = resolveOutputTemplate(
          resolvedDownloadFolder,
          options.outputTemplate,
          {
            bundle: trove["human-name"],
            publisher,
            product: trove["human-name"],
            format: platform,
            ext,
            year: itemDate.getUTCFullYear().toString(),
            month: isoDate.slice(5, 7),
            day: isoDate.slice(8, 10),
            date: isoDate,
            gamekey: trove.machine_name,
            platform,
            filename: rawBaseName,
          },
        );
        fileName = resolved.fileName;
        downloadPath = resolved.downloadPath;
        filePath = resolved.filePath;
      } else {
        fileName = sanitizeFilename(rawBaseName);
        downloadPath = resolve(resolvedDownloadFolder, sanitizedTroveName);
        filePath = resolve(downloadPath, fileName);
      }

      downloads.push({
        bundle: trove["human-name"],
        gameKey: trove.machine_name,
        subProductId,
        name: trove["human-name"],
        publisher,
        icon: trove.image,
        machineName: download.machine_name,
        fileName,
        downloadPath,
        filePath,
        url: placeholderUrl,
        webFilename: options.torrent && download.url.bittorrent
          ? download.url.bittorrent
          : download.url.web,
        sha1: download.sha1,
        md5: download.md5,
        structName: fileName,
        date: itemDate,
        file_size: download.file_size,
      });
    }
  }
  totals.filteredDownloads = downloads.length;
  return sortDownloads(downloads);
}
