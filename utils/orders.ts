import { yellow } from "@std/fmt/colors";
import { basename, extname, resolve } from "@std/path";
import sanitizeFilename from "sanitize-filename";
import { normalizeFormat } from "./generic.ts";
import { MultiBar } from "./progress.ts";

import {
  Bundle,
  DownloadStruct,
  Platform,
  SubProduct,
} from "../types/bundle.ts";
import { DownloadInfo, Options, Totals } from "../types/general.ts";

/**
 * Create download information from bundle data
 */
function createDownloadInfo(
  bundle: Bundle,
  subProduct: SubProduct,
  struct: DownloadStruct,
  options: Options,
  date: Date,
): DownloadInfo {
  const url = new URL(struct.url.web);

  // Generate filename based on options
  const fileName = sanitizeFilename(
    options.humanFileNames
      ? `${subProduct.human_name}${extname(basename(url.pathname))}`
      : basename(url.pathname),
  );

  // Build download path according to folder structure options
  const downloadPath = resolve(
    options.downloadFolder,
    options.bundleFolders ? sanitizeFilename(bundle.product.human_name) : "",
    options.productFolders ? sanitizeFilename(subProduct.human_name) : "",
  );

  // Resolve final file path
  const filePath = resolve(downloadPath, fileName);

  return {
    bundle: bundle.product.human_name,
    name: subProduct.human_name,
    machineName: subProduct.machine_name,
    fileName,
    downloadPath,
    filePath,
    url,
    sha1: struct.sha1,
    md5: struct.md5,
    structName: struct.name ?? fileName,
    date,
    file_size: struct.file_size,
  };
}

/**
 * Check if a download is a duplicate based on filename or checksums
 */
function isDuplicateDownload(
  downloads: DownloadInfo[],
  downloadInfo: DownloadInfo,
  struct: DownloadStruct,
  options: Options,
): boolean {
  if (!options.dedup) return false;

  return downloads.some(
    (elem) =>
      elem.fileName.toLocaleLowerCase() ===
        downloadInfo.fileName.toLocaleLowerCase() ||
      (struct.sha1 &&
        struct.sha1.toLocaleLowerCase() === elem.sha1?.toLocaleLowerCase() &&
        struct.md5 &&
        struct.md5.toLocaleLowerCase() === elem.md5?.toLocaleLowerCase()),
  );
}

/**
 * Filter bundles to create a list of downloadable items
 */
export function filterBundles(
  bundles: Bundle[],
  options: Options,
  totals: Totals,
  progress: MultiBar,
): DownloadInfo[] {
  progress.log(
    `${
      yellow(bundles.length.toString())
    } bundles containing downloadable items`,
  );
  const downloads: DownloadInfo[] = [];

  for (const bundle of bundles) {
    for (const subProduct of bundle.subproducts) {
      const platformDownloads = subProduct.downloads
        .filter((elem) => options.platform.includes(elem.platform));

      for (const download of platformDownloads) {
        for (const struct of download.download_struct) {
          if (struct.url) {
            totals.preFilteredDownloads++;
            const downloadInfo = createDownloadInfo(
              bundle,
              subProduct,
              struct,
              options,
              struct.uploaded_at
                ? new Date(struct.uploaded_at)
                : new Date(bundle.created),
            );
            const isDuplicate = isDuplicateDownload(
              downloads,
              downloadInfo,
              struct,
              options,
            );

            if (!isDuplicate) {
              const pathMatch = downloads.some((elem) =>
                elem.filePath.toLocaleLowerCase() ===
                  downloadInfo.filePath.toLocaleLowerCase()
              );

              if (!pathMatch) {
                downloads.push(downloadInfo);
              } else {
                const duplicate = downloads.find((elem) =>
                  elem.filePath.toLocaleLowerCase() ===
                    downloadInfo.filePath.toLocaleLowerCase()
                );
                progress.log(
                  `Potential duplicate purchase ${downloadInfo.fileName}, ${bundle.product.human_name}, ${duplicate?.bundle}, ${duplicate?.fileName}`,
                );
              }
            } else {
              const duplicate = downloads.find((elem) =>
                elem.fileName.toLocaleLowerCase() ===
                  downloadInfo.fileName.toLocaleLowerCase()
              );
              progress.log(
                `Potential duplicate purchase ${downloadInfo.fileName}, ${bundle.product.human_name}, ${duplicate?.bundle}, ${duplicate?.fileName}`,
              );
            }
          }
        }
      }
    }
  }

  totals.filteredDownloads = downloads.length;
  return downloads.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Filter bundles to create a list of ebook downloads
 * Priority of format to download cbz → epub → pdf_hd → pdf → mobi
 */
export function filterEbooks(
  bundles: Bundle[],
  options: Options,
  totals: Totals,
  progress: MultiBar,
): DownloadInfo[] {
  progress.log(
    `${yellow(bundles.length.toString())} bundles containing ebooks`,
  );
  let downloads: DownloadInfo[] = [];

  for (const bundle of bundles) {
    let date = new Date(bundle.created);

    for (const subProduct of bundle.subproducts) {
      const filteredDownloads = subProduct.downloads.filter((elem) =>
        elem.platform === Platform.Ebook
      );

      for (const format of options.format) {
        for (const download of filteredDownloads) {
          for (const struct of download.download_struct) {
            if (
              struct.name &&
              struct.url &&
              normalizeFormat(struct.name) === format
            ) {
              totals.preFilteredDownloads++;
              const uploaded_at = struct.uploaded_at
                ? new Date(struct.uploaded_at)
                : new Date(bundle.created);

              if (uploaded_at > date) date = uploaded_at;

              // Find existing download of the same ebook (if deduplication enabled)
              let existing;
              if (options.dedup) {
                existing = downloads.find((elem) =>
                  elem.machineName.toLocaleLowerCase() ===
                    subProduct.machine_name.toLocaleLowerCase()
                );
              }

              // Keep newer version or if no existing version exists
              const shouldKeep = !existing || (
                date > existing.date &&
                struct.name.toLocaleLowerCase() ===
                  existing.structName.toLocaleLowerCase()
              );

              if (shouldKeep) {
                // Remove existing version if we're replacing it
                if (existing) {
                  downloads = downloads.filter(
                    (elem) =>
                      elem.machineName.toLocaleLowerCase() !==
                        existing.machineName.toLocaleLowerCase(),
                  );
                }

                const downloadInfo = createDownloadInfo(
                  bundle,
                  subProduct,
                  struct,
                  options,
                  struct.uploaded_at
                    ? new Date(struct.uploaded_at)
                    : new Date(bundle.created),
                );

                // Check for path duplicates
                const pathDuplicate = downloads.some((elem) =>
                  elem.filePath.toLocaleLowerCase() ===
                    downloadInfo.filePath.toLocaleLowerCase()
                );

                if (!pathDuplicate) {
                  downloads.push(downloadInfo);
                } else {
                  progress.log(
                    `Potential duplicate purchase ${downloadInfo.fileName}, ${bundle.product.human_name}, ${existing?.bundle}, ${existing?.fileName}`,
                  );
                }
              }
            }
          }
        }
      }
    }
  }

  totals.filteredDownloads = downloads.length;
  return downloads.sort((a, b) => a.name.localeCompare(b.name));
}
