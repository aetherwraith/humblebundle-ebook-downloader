import { isEql } from "@opentf/std";
import { yellow } from "@std/fmt/colors";
import { basename, resolve } from "@std/path";
import type { MultiBar } from "cli-progress";
import sanitizeFilename from "sanitize-filename";
import { normalizeFormat } from "./generic.ts";
import {
  Bundle,
  DownloadStruct,
  Options,
  Platform,
  SubProduct,
  Totals,
} from "./types.ts";

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
  return (
    options.dedup &&
    downloads.some(
      (elem) =>
        isEql(
          elem.fileName.toLocaleLowerCase(),
          downloadInfo.fileName.toLocaleLowerCase(),
        ) ||
        (struct.sha1 &&
          isEql(
            struct.sha1.toLocaleLowerCase(),
            elem.sha1?.toLocaleLowerCase(),
          ) &&
          struct.md5 &&
          isEql(struct.md5.toLocaleLowerCase(), elem.md5?.toLocaleLowerCase())),
    )
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
      yellow(
        bundles.length.toString(),
      )
    } bundles containing downloadable items`,
  );
  const downloads: DownloadInfo[] = [];

  bundles.forEach((bundle) => {
    bundle.subproducts.forEach((subProduct) => {
      subProduct.downloads
        .filter((elem) => options.platform.includes(elem.platform))
        .forEach((download) => {
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
                    isEql(
                      elem.filePath.toLocaleLowerCase(),
                      downloadInfo.filePath.toLocaleLowerCase(),
                    )
                  )
                ) {
                  downloads.push(downloadInfo);
                } else {
                  const duplicate = downloads.find((elem) =>
                    isEql(
                      elem.filePath.toLocaleLowerCase(),
                      downloadInfo.filePath.toLocaleLowerCase(),
                    )
                  );
                  progress.log(
                    `Potential duplicate purchase ${downloadInfo.fileName}, ${bundle.product.human_name}, ${duplicate?.bundle}, ${duplicate?.fileName}`,
                  );
                }
              } else {
                const duplicate = downloads.find((elem) =>
                  isEql(
                    elem.fileName.toLocaleLowerCase(),
                    downloadInfo.fileName.toLocaleLowerCase(),
                  )
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
        isEql(elem.platform, Platform.Ebook)
      );
      options.format.forEach((format) => {
        filteredDownloads.forEach((download) =>
          download.download_struct.forEach((struct) => {
            if (
              struct.name &&
              struct.url &&
              isEql(normalizeFormat(struct.name), format)
            ) {
              totals.preFilteredDownloads++;
              const uploaded_at = struct.uploaded_at
                ? new Date(struct.uploaded_at)
                : new Date(bundle.created);
              if (uploaded_at > date) date = uploaded_at;
              // TODO: check hash matches too
              let existing;
              if (options.dedup) {
                existing = downloads.find((elem) =>
                  isEql(
                    elem.machineName.toLocaleLowerCase(),
                    subProduct.machine_name.toLocaleLowerCase(),
                  )
                );
              }
              if (
                !existing ||
                (date > existing.date &&
                  isEql(
                    struct.name.toLocaleLowerCase(),
                    existing.structName.toLocaleLowerCase(),
                  ))
              ) {
                if (existing) {
                  downloads = downloads.filter(
                    (elem) =>
                      !isEql(
                        elem.machineName.toLocaleLowerCase(),
                        existing.machineName.toLocaleLowerCase(),
                      ),
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
                    isEql(
                      elem.filePath.toLocaleLowerCase(),
                      downloadInfo.filePath.toLocaleLowerCase(),
                    )
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
