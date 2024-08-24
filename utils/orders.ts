import {Bundle, Options, Totals} from "./types.ts";
import * as log from "@std/log";
import { yellow } from "@std/fmt/colors";
import sanitizeFilename from "sanitize-filename";
import { basename, extname, resolve } from "@std/path";


export interface DownloadInfo {
    bundle: string;
    name: string;
    fileName: string;
    downloadPath: string;
    filePath: string;
    url: URL;
    sha1: string;
    md5: string;
}

export function filterBundles(bundles: Bundle[], options: Options, totals: Totals) {
    log.info(
        `${yellow(bundles.length.toString())} bundles containing downloadable items`
    );
    const downloads:DownloadInfo[] = [];
    bundles.forEach(bundle => {
        bundle.subproducts.forEach(subProduct => {
            subProduct.downloads.forEach(download => {
                download.download_struct.forEach(struct => {
                    if (struct.url) {
                        totals.preFilteredDownloads++;
                        const url = new URL(struct.url.web);
                        const fileName = sanitizeFilename(basename(url.pathname));
                        const downloadPath = resolve(
                            options.downloadFolder,
                            options.bundleFolders ? sanitizeFilename(bundle.product.human_name) : '',
                        sanitizeFilename(subProduct.human_name),
                        );
                        const filePath = resolve(downloadPath, fileName);

                        let existing = false;
                        if (options.dedup) {
                            existing = downloads.some(elem => {
                                return (
                                    elem.fileName === fileName ||
                                    (struct.sha1 && struct.sha1 === elem.sha1) ||
                                    (struct.md5 && struct.md5 === elem.md5)
                                );
                            });
                        }
                        if (!existing) {
                            if (!downloads.some(elem => elem.filePath === filePath)) {
                                downloads.push(<DownloadInfo>{
                                    bundle: bundle.product.human_name,
                                    name: subProduct.human_name,
                                    fileName,
                                    downloadPath,
                                    filePath,
                                    url,
                                    sha1: struct.sha1,
                                    md5: struct.md5,
                                });
                            } else {
                                const duplicate = downloads.find(elem => elem.filePath === filePath)
                                log.info(`Potential duplicate purchase ${fileName}, ${bundle.product.human_name}, ${duplicate?.bundle}, ${duplicate?.fileName}`);
                            }
                        } else {
                            const duplicate = downloads.find(elem => {
                                return (
                                    elem.fileName === fileName ||
                                    (struct.sha1 && struct.sha1 === elem.sha1) ||
                                    (struct.md5 && struct.md5 === elem.md5)
                                );
                            })
                            log.info(`Potential bob purchase ${fileName}, ${bundle.product.human_name}, ${duplicate?.bundle}, ${duplicate?.fileName}`);
                        }
                    }
                });
            });
        });
    });
    totals.filteredDownloads = downloads.length;
    return downloads.sort((a, b) => a.name.localeCompare(b.name));
}
