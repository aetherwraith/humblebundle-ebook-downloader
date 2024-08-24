import {
  Bundle,
  DownloadStruct,
  Options,
  SubProduct,
  Totals,
} from "./types.ts";
import * as log from "@std/log";
import { yellow } from "@std/fmt/colors";
import sanitizeFilename from "sanitize-filename";
import { basename, resolve } from "@std/path";
import { normalizeFormat } from "./generic.ts";

export interface DownloadInfo {
  bundle: string;
  name: string;
  fileName: string;
  downloadPath: string;
  filePath: string;
  url: URL;
  sha1?: string;
  md5?: string;
  machineName: string;
}

function createDownloadInfo(
  bundle: Bundle,
  subProduct: SubProduct,
  struct: DownloadStruct,
  options: Options,
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
) {
  log.info(
    `${
      yellow(bundles.length.toString())
    } bundles containing downloadable items`,
  );
  const downloads: DownloadInfo[] = [];

  bundles.forEach((bundle) => {
    bundle.subproducts.forEach((subProduct) => {
      subProduct.downloads.forEach((download) => {
        download.download_struct.forEach((struct) => {
          if (struct.url) {
            totals.preFilteredDownloads++;
            const downloadInfo = createDownloadInfo(
              bundle,
              subProduct,
              struct,
              options,
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
                log.info(
                  `Potential duplicate purchase ${downloadInfo.fileName}, ${bundle.product.human_name}, ${duplicate?.bundle}, ${duplicate?.fileName}`,
                );
              }
            } else {
              const duplicate = downloads.find((elem) =>
                elem.fileName === downloadInfo.fileName
              );
              log.info(
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

async function filterEbooks(
  bundles: Bundle[],
  options: Options,
  totals: Totals,
) {
  // priority of format to download cbz -> epub -> pdf_hd -> pdf -> mobi
  log.info(
    `${yellow(bundles.length.toString())} bundles containing ebooks`,
  );
  const downloads: DownloadInfo[] = [];
  bundles.forEach((bundle) => {
    let date = new Date(bundle.created);
    bundle.subproducts.forEach((subProduct) => {
      const filteredDownloads = subProduct.downloads;
      options.format.forEach((format) => {
        filteredDownloads.forEach((download) =>
          download.download_struct.forEach((struct) => {
            if (
              struct.name &&
              struct.url &&
              normalizeFormat(struct.name) === format
            ) {
              if (
                struct.name.toLowerCase().localeCompare("download") === 0 &&
                struct.url.web.toLowerCase().indexOf(".pdf") < 0
              ) {
                return;
              }
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
                const downloadPath = path.resolve(
                  downloadFolder,
                  bundleFolders
                    ? sanitizeFilename(bundle.product.human_name)
                    : "",
                  sanitizeFilename(subProduct.human_name),
                );
                const url = new URL(struct.url.web);
                const fileName = `${subProduct.machine_name}${
                  getExtension(
                    normalizeFormat(struct.name),
                  )
                }`;
                const filePath = path.resolve(
                  downloadPath,
                  sanitizeFilename(fileName),
                );
                const cacheKey = path.join(
                  sanitizeFilename(bundle.product.human_name),
                  sanitizeFilename(fileName),
                );
                if (!downloads.some((elem) => elem.filePath === filePath)) {
                  // in case we have duplicate purchases check the cacheKey for uniqueness
                  downloads.push({
                    bundle: bundle.product.human_name,
                    // download: struct,
                    name: subProduct.human_name,
                    cacheKey,
                    fileName,
                    downloadPath,
                    filePath,
                    url,
                    sha1: struct.sha1,
                    md5: struct.md5,
                    machineName: subProduct.machine_name,
                    structName: struct.name,
                  });
                } else {
                  log.info(`Potential duplicate purchase ${cacheKey}`);
                }
              }
            }
          })
        );
      });
    });
  });
  return downloads.sort((a, b) => a.name.localeCompare(b.name));
}
