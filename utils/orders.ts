import { isEql } from "@opentf/std";
import { yellow } from "@std/fmt/colors";
import { basename, extname, resolve } from "@std/path";
import { MultiBarWrapper } from "./progressWrapper.ts";
import sanitizeFilename from "sanitize-filename";
import { normalizeFormat } from "./generic.ts";
import {
  Bundle,
  DownloadStruct,
  Platform,
  SubProduct,
} from "../types/bundle.ts";
import { DownloadInfo, Options, Totals } from "../types/general.ts";

function createDownloadInfo(
  bundle: Bundle,
  subProduct: SubProduct,
  struct: DownloadStruct,
  options: Options,
  date: Date,
): DownloadInfo {
  // Check if struct.url is defined
  if (!struct.url) {
    // Handle the case where struct.url is undefined, e.g., throw an error or return a default/null value
    // For now, let's assume it should not be undefined if we reach this point, or throw an error.
    // Or, if the caller ensures struct.url is always present, this check might be redundant.
    // Given the original code directly used struct.url.web, this implies it was expected to be defined.
    // If it can be undefined, the return type or error handling needs to be adjusted.
    // For the purpose of this edit, we'll assume the user wants to ensure it's defined before proceeding.
    // A more robust solution might involve returning `null` or throwing an error,
    // but that would change the function's signature or require more extensive changes.
    // For now, we'll proceed with a type assertion or assume it's handled upstream.
    // To strictly follow the instruction "Check if struct.url is defined" and make the code syntactically correct
    // without changing the return type, we'll add a guard and assume valid data.
    throw new Error(
      "DownloadStruct.url is undefined, cannot create DownloadInfo.",
    );
  }
  const url = new URL(struct.url.web);
  const fileName = sanitizeFilename(
    options.humanFileNames
      ? `${subProduct.human_name}${extname(basename(url.pathname))}`
      : basename(url.pathname),
  );
  const downloadPath = resolve(
    options.downloadFolder,
    options.bundleFolders ? sanitizeFilename(bundle.product.human_name) : "",
    options.productFolders ? sanitizeFilename(subProduct.human_name) : "",
  );
  const filePath = resolve(downloadPath, fileName);

  return {
    bundle: bundle.product.human_name,
    gameKey: bundle.gamekey,
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

export function filterBundles(
  bundles: Bundle[],
  options: Options,
  totals: Totals,
  progress: MultiBarWrapper,
) {
  progress.log(
    `${
      yellow(
        bundles.length.toString(),
      )
    } bundles containing downloadable items`,
  );
  const downloads: DownloadInfo[] = [];
  const byFilePath = new Map<string, DownloadInfo>();
  const byFileName = new Map<string, DownloadInfo>();
  const byHash = new Map<string, DownloadInfo>();

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

              // Check for duplicates using Maps
              let isDuplicate = false;
              if (options.dedup) {
                if (byFileName.has(downloadInfo.fileName.toLocaleLowerCase())) {
                  isDuplicate = true;
                } else if (struct.sha1 && struct.md5) {
                  const key =
                    `${struct.sha1.toLocaleLowerCase()}|${struct.md5.toLocaleLowerCase()}`;
                  if (byHash.has(key)) {
                    isDuplicate = true;
                  }
                }
              }

              if (!isDuplicate) {
                const existingPath = byFilePath.get(
                  downloadInfo.filePath.toLocaleLowerCase(),
                );
                if (!existingPath) {
                  downloads.push(downloadInfo);
                  byFilePath.set(
                    downloadInfo.filePath.toLocaleLowerCase(),
                    downloadInfo,
                  );
                  byFileName.set(
                    downloadInfo.fileName.toLocaleLowerCase(),
                    downloadInfo,
                  );
                  if (downloadInfo.sha1 && downloadInfo.md5) {
                    byHash.set(
                      `${downloadInfo.sha1.toLocaleLowerCase()}|${downloadInfo.md5.toLocaleLowerCase()}`,
                      downloadInfo,
                    );
                  }
                } else {
                  const duplicate = existingPath;
                  progress.log(
                    `Potential duplicate purchase ${downloadInfo.fileName}, ${bundle.product.human_name}, ${duplicate?.bundle}, ${duplicate?.fileName}`,
                  );
                }
              } else {
                const duplicate = byFileName.get(
                  downloadInfo.fileName.toLocaleLowerCase(),
                ); // Or byHash
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
  return downloads.sort((a, b) =>
    (b.file_size || 0) - (a.file_size || 0) || a.name.localeCompare(b.name)
  );
}

export function filterEbooks(
  bundles: Bundle[],
  options: Options,
  totals: Totals,
  progress: MultiBarWrapper,
) {
  // priority of format to download cbz → epub → pdf_hd → pdf → mobi
  progress.log(
    `${yellow(bundles.length.toString())} bundles containing ebooks`,
  );

  const activeDownloads = new Set<DownloadInfo>();
  const byMachineName = new Map<string, DownloadInfo>();
  const byFilePath = new Map<string, DownloadInfo>();

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

              let existing: DownloadInfo | undefined;
              if (options.dedup) {
                existing = byMachineName.get(
                  subProduct.machine_name.toLocaleLowerCase(),
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
                  activeDownloads.delete(existing);
                  byMachineName.delete(
                    subProduct.machine_name.toLocaleLowerCase(),
                  );
                  byFilePath.delete(existing.filePath.toLocaleLowerCase());
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
                  !byFilePath.has(downloadInfo.filePath.toLocaleLowerCase())
                ) {
                  activeDownloads.add(downloadInfo);
                  if (options.dedup) {
                    byMachineName.set(
                      subProduct.machine_name.toLocaleLowerCase(),
                      downloadInfo,
                    );
                  }
                  byFilePath.set(
                    downloadInfo.filePath.toLocaleLowerCase(),
                    downloadInfo,
                  );
                } else {
                  const duplicate = byFilePath.get(
                    downloadInfo.filePath.toLocaleLowerCase(),
                  );
                  progress.log(
                    `Potential duplicate purchase ${downloadInfo.fileName}, ${bundle.product.human_name}, ${duplicate?.bundle}, ${duplicate?.fileName}`,
                  );
                }
              }
            }
          })
        );
      });
    });
  });

  const downloads = Array.from(activeDownloads);
  totals.filteredDownloads = downloads.length;
  return downloads.sort((a, b) =>
    (b.file_size || 0) - (a.file_size || 0) || a.name.localeCompare(b.name)
  );
}
