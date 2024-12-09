import {
  Bundle,
  DownloadStruct,
  Options,
  Platform,
  SubProduct,
  Totals,
} from "./types.ts";
import { yellow } from "@std/fmt/colors";
import sanitizeFilename from "sanitize-filename";
import { basename, resolve } from "@std/path";
import { normalizeFormat } from "./generic.ts";
import type { MultiBar } from "cli-progress";

export interface DownloadInfo {
  date: Date;
  bundle: string;
  name: string;
  fileName: string;
  downloadPath: string;
  filePath: string;
  url: URL;
  sha1?: string;
  md5?: string;
  machineName: string;
  structName: string;
  file_size?: number;
}

function createDownloadInfo(
  bundle: Bundle,
  subProduct: SubProduct,
  struct: DownloadStruct,
  options: Options,
  date: Date,
): DownloadInfo {
  const url = new URL(struct.url.web);
  const fileName = sanitizeFilename(basename(url.pathname));
  const downloadPath = resolve(
    options.downloadFolder,
    options.bundleFolders ? sanitizeFilename(bundle.product.human_name) : "",
    sanitizeFilename(subProduct.human_name),
  );
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

function isDuplicateDownload(
  downloads: DownloadInfo[],
  downloadInfo: DownloadInfo,
  struct: DownloadStruct,
  options: Options,
): boolean {
  return options.dedup &&
    downloads.some((elem) =>
      elem.fileName === downloadInfo.fileName ||
      (struct.sha1 && struct.sha1 === elem.sha1) &&
        (struct.md5 && struct.md5 === elem.md5)
    );
}

export function filterBundles(
  bundles: Bundle[],
  options: Options,
  totals: Totals,
  progress: MultiBar,
) {
  progress.log(
    `${
      yellow(bundles.length.toString())
    } bundles containing downloadable items`,
  );
  const downloads: DownloadInfo[] = [];

  bundles.forEach((bundle) => {
    bundle.subproducts.forEach((subProduct) => {
      subProduct.downloads.filter((elem) =>
        options.platform.includes(elem.platform)
      ).forEach((download) => {
        download.download_struct.forEach((struct) => {
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
              if (
                !downloads.some((elem) =>
                  elem.filePath === downloadInfo.filePath
                )
              ) {
                downloads.push(downloadInfo);
              } else {
                const duplicate = downloads.find((elem) =>
                  elem.filePath === downloadInfo.filePath
                );
                progress.log(
                  `Potential duplicate purchase ${downloadInfo.fileName}, ${bundle.product.human_name}, ${duplicate?.bundle}, ${duplicate?.fileName}`,
                );
              }
            } else {
              const duplicate = downloads.find((elem) =>
                elem.fileName === downloadInfo.fileName
              );
              progress.log(
                `Potential bob purchase ${downloadInfo.fileName}, ${bundle.product.human_name}, ${duplicate?.bundle}, ${duplicate?.fileName}`,
              );
            }
          }
        });
      });
    });
  });

  totals.filteredDownloads = downloads.length;
  return downloads.sort((a, b) => a.name.localeCompare(b.name));
}

export function filterEbooks(
  bundles: Bundle[],
  options: Options,
  totals: Totals,
  progress: MultiBar,
) {
  // priority of format to download cbz → epub → pdf_hd → pdf → mobi
  progress.log(
    `${yellow(bundles.length.toString())} bundles containing ebooks`,
  );
  let downloads: DownloadInfo[] = [];
  bundles.forEach((bundle) => {
    let date = new Date(bundle.created);
    bundle.subproducts.forEach((subProduct) => {
      const filteredDownloads = subProduct.downloads.filter((elem) =>
        elem.platform === Platform.Ebook
      );
      options.format.forEach((format) => {
        filteredDownloads.forEach((download) =>
          download.download_struct.forEach((struct) => {
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
              // TODO: check hash matches too
              let existing;
              if (options.dedup) {
                existing = downloads.find(
                  (elem) => elem.machineName === subProduct.machine_name,
                );
              }
              if (
                !existing ||
                (date > existing.date && struct.name === existing.structName)
              ) {
                if (existing) {
                  downloads = downloads.filter(
                    (elem) => elem.machineName !== existing.machineName,
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

                if (
                  !downloads.some((elem) =>
                    elem.filePath === downloadInfo.filePath
                  )
                ) {
                  downloads.push(downloadInfo);
                } else {
                  progress.log(
                    `Potential duplicate purchase ${downloadInfo.fileName}, ${bundle.product.human_name}, ${existing?.bundle}, ${existing?.fileName}`,
                  );
                }
              }
            }
          })
        );
      });
    });
  });
  totals.filteredDownloads = downloads.length;
  return downloads.sort((a, b) => a.name.localeCompare(b.name));
}
