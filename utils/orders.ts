import {Bundle, DownloadStruct, Options, SubProduct, Totals} from "./types.ts";
import * as log from "@std/log";
import {yellow} from "@std/fmt/colors";
import sanitizeFilename from "sanitize-filename";
import {basename, resolve} from "@std/path";

export interface DownloadInfo {
    bundle: string;
    name: string;
    fileName: string;
    downloadPath: string;
    filePath: string;
    url: URL;
    sha1?: string;
    md5?: string;
}

function createDownloadInfo(bundle: Bundle, subProduct: SubProduct, struct: DownloadStruct, options: Options): DownloadInfo {
    const url = new URL(struct.url.web);
    const fileName = sanitizeFilename(basename(url.pathname));
    const downloadPath = resolve(
        options.downloadFolder,
        options.bundleFolders ? sanitizeFilename(bundle.product.human_name) : '',
        sanitizeFilename(subProduct.human_name)
    );
    const filePath = resolve(downloadPath, fileName);

    return {
        bundle: bundle.product.human_name,
        name: subProduct.human_name,
        fileName,
        downloadPath,
        filePath,
        url,
        sha1: struct.sha1,
        md5: struct.md5,
    };
}

function isDuplicateDownload(downloads: DownloadInfo[], downloadInfo: DownloadInfo, struct: DownloadStruct, options: Options): boolean {
    return options.dedup && downloads.some(elem =>
        elem.fileName === downloadInfo.fileName ||
        (struct.sha1 && struct.sha1 === elem.sha1) ||
        (struct.md5 && struct.md5 === elem.md5)
    );
}

export function filterBundles(bundles: Bundle[], options: Options, totals: Totals) {
    log.info(`${yellow(bundles.length.toString())} bundles containing downloadable items`);
    const downloads: DownloadInfo[] = [];

    bundles.forEach(bundle => {
        bundle.subproducts.forEach(subProduct => {
            subProduct.downloads.forEach(download => {
                download.download_struct.forEach(struct => {
                    if (struct.url) {
                        totals.preFilteredDownloads++;
                        const downloadInfo = createDownloadInfo(bundle, subProduct, struct, options);
                        const isDuplicate = isDuplicateDownload(downloads, downloadInfo, struct, options);

                        if (!isDuplicate) {
                            if (!downloads.some(elem => elem.filePath === downloadInfo.filePath)) {
                                downloads.push(downloadInfo);
                            } else {
                                const duplicate = downloads.find(elem => elem.filePath === downloadInfo.filePath);
                                log.info(`Potential duplicate purchase ${downloadInfo.fileName}, ${bundle.product.human_name}, ${duplicate?.bundle}, ${duplicate?.fileName}`);
                            }
                        } else {
                            const duplicate = downloads.find(elem => elem.fileName === downloadInfo.fileName);
                            log.info(`Potential bob purchase ${downloadInfo.fileName}, ${bundle.product.human_name}, ${duplicate?.bundle}, ${duplicate?.fileName}`);
                        }
                    }
                });
            });
        });
    });

    totals.filteredDownloads = downloads.length;
    return downloads.sort((a, b) => a.name.localeCompare(b.name));
}
