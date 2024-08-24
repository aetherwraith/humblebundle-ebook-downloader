import {DownloadInfo} from "./orders.ts";
import {checkSignatureMatch, computeFileHash} from "./checksums.ts";
import {Checksums, Totals} from "./types.ts";
import {formatFileSize} from "./formatNumbers.ts";
import {basename} from "@std/path/basename";
import {green} from "@std/fmt/colors";
import { resolve } from "@std/path/resolve";

export async function downloadItem(download: DownloadInfo, checksums: Record<string, Checksums>, progress,downloadProgress, queues, totals: Totals): Promise<void> {
    if (await queues.fileCheck.add(() => checkSignatureMatch(download, checksums, progress))) {
        totals.doneDownloads++;
        downloadProgress.increment();
    } else {
        queues.downloads.add(() => doDownload(download));
    }
}

const downloadProgress = {
    start() {
        this.downloadBar = this.progress.create(
            this.size,
            this.completed,
            {
                file: green(`Downloading: ${basename(this.file)}`),
            },
            { formatValue: formatFileSize },
        );
    },
    transform(chunk, controller) {
        this.completed += chunk.byteLength;
        this.downloadBar.increment(chunk.byteLength);
        controller.enqueue(chunk);
    },
    flush() {
        this.progress.remove(this.downloadBar);
    },
};

class DownloadProgress extends TransformStream {
    constructor(
        size: number,
        file: string,
        progress: unknown,
    ) {
        super({
            ...downloadProgress,
            size,
            file,
            progress,
            completed: 0,
        });
    }
}

export async function doDownload(
    download: DownloadInfo,
    progress: unknown,
) {
    const filePath = resolve(download.filePath);
    using fileStream = await Deno.open(filePath, { read: true, write: true, create: true });

}
