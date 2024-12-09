import { resolve } from "@std/path";
import { crypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";
import { Checksums } from "./types.ts";
import { exists } from "@std/fs/exists";
import { DownloadInfo } from "./orders.ts";
import { StreamProgress } from "./streamProgress.ts";
import { yellow } from "@std/fmt/colors";
import type { MultiBar } from "cli-progress";

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
  progress: MultiBar,
): Promise<Checksums> {
  const filePath = resolve(file);
  const { size } = await Deno.stat(filePath);
  const fileStream = await Deno.open(filePath, { read: true });
  const pipedStreams = fileStream.readable.pipeThrough(
    new StreamProgress(size, file, progress, "Hashing", yellow),
  );
  return computeFileHash(pipedStreams);
}

export async function checkSignatureMatch(
  download: DownloadInfo,
  checksums: Record<string, Checksums>,
  progress: MultiBar,
): Promise<boolean> {
  if (!(await exists(download.filePath))) return false;

  const hash = await getOrComputeChecksum(
    download.fileName,
    download.filePath,
    checksums,
    progress,
  );
  return isHashVerified(download, hash);
}

async function getOrComputeChecksum(
  fileName: string,
  filePath: string,
  checksums: Record<string, Checksums>,
  progress: MultiBar,
): Promise<Checksums> {
  if (checksums[fileName]?.md5 && checksums[fileName]?.sha1) {
    return checksums[fileName];
  }

  const hash = await checksum(filePath, progress);
  checksums[fileName] = hash;
  return hash;
}

function isHashVerified(download: DownloadInfo, hash: Checksums): boolean {
  return (download.sha1 && download.sha1 === hash.sha1) ||
    (download.md5 && download.md5 === hash.md5) || false;
}
