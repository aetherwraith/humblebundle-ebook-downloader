import { WalkEntry } from "@std/fs/walk";
import { resolve } from "@std/path";
import { crypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";
import { formatFileSize } from "./formatNumbers.ts";
import { yellow } from "@std/fmt/colors";
import { Checksums } from "./types.ts";
import {exists} from "@std/fs/exists";
import { DownloadInfo } from "./orders.ts";
import {basename} from "@std/path/basename";

const checkSumProgress = {
  start() {
    this.checksumBar = this.progress.create(
      this.size,
      this.completed,
      {
        file: yellow(`Hashing: ${basename(this.file)}`),
      },
      { formatValue: formatFileSize },
    );
  },
  transform(chunk, controller) {
    this.completed += chunk.byteLength;
    this.checksumBar.increment(chunk.byteLength);
    controller.enqueue(chunk);
  },
  flush() {
    this.progress.remove(this.checksumBar);
  },
};

class ChecksumProgress extends TransformStream {
  constructor(
    size: number,
    file: string,
    progress: unknown,
  ) {
    super({
      ...checkSumProgress,
      size,
      file,
      progress,
      completed: 0,
    });
  }
}

export async function computeFileHash(
  stream: ReadableStream<Uint8Array>,
): Promise<Checksums> {
  const [shaStream, md5Stream] = stream.tee();
  const [shaHashBuffer, md5HashBuffer] = await Promise.all([
    crypto.subtle.digest("SHA-1", shaStream),
    crypto.subtle.digest("MD5", md5Stream),
  ]);
  return {
    sha1: encodeHex(shaHashBuffer),
    md5: encodeHex(md5HashBuffer),
  };
}

export async function checksum(
  file: string,
  progress: unknown,
): Promise<Checksums> {
  const filePath = resolve(file);
  const { size } = await Deno.stat(filePath);
  using fileStream = await Deno.open(filePath, { read: true });
  const pipedStreams = fileStream.readable.pipeThrough(
    new ChecksumProgress(size, file, progress),
  );
  return computeFileHash(pipedStreams);
}

export async function checkSignatureMatch(download: DownloadInfo, checksums: Record<string, Checksums>, progress: unknown): Promise<boolean> {
    if (!(await exists(download.filePath))) return false;

    const hash = await getOrComputeChecksum(download.fileName, download.filePath, checksums, progress);
    return isHashVerified(download, hash);
}

async function getOrComputeChecksum(fileName: string, filePath: string, checksums: Record<string, Checksums>, progress: unknown): Promise<Checksums> {
    if (checksums[fileName]) return checksums[fileName];

    const hash = await checksum(filePath, progress);
    checksums[fileName] = hash;
    return hash;
}

function isHashVerified(download: DownloadInfo, hash: Checksums): boolean {
    return (download.sha1 && download.sha1 === hash.sha1) || (download.md5 && download.md5 === hash.md5);
}
