import { crypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";
import { yellow } from "@std/fmt/colors";
import { resolve } from "@std/path";
import { MultiBar } from "./progress.ts";
import { StreamProgress } from "./streamProgress.ts";

import { DownloadInfo, Totals } from "../types/general.ts";
import { Checksums } from "../types/bundle.ts";

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
  using fileStream = await Deno.open(filePath, { read: true });
  const pipedStreams = fileStream.readable.pipeThrough(
    new StreamProgress(size, file, progress, "Hashing", yellow),
  );
  const fileHash = await computeFileHash(pipedStreams);
  return fileHash;
}

export async function checkSignatureMatch(
  download: DownloadInfo,
  checksums: Record<string, Checksums>,
  progress: MultiBar,
  totals: Totals,
): Promise<boolean> {
  try {
    await Deno.stat(download.filePath);
  } catch {
    return false;
  }

  const hash = await getOrComputeChecksum(
    download.fileName,
    download.filePath,
    checksums,
    progress,
    totals,
  );
  return isHashVerified(download, hash);
}

async function getOrComputeChecksum(
  fileName: string,
  filePath: string,
  checksums: Record<string, Checksums>,
  progress: MultiBar,
  totals: Totals,
): Promise<Checksums> {
  if (checksums[fileName]?.md5 && checksums[fileName]?.sha1) {
    return checksums[fileName];
  }

  const hash = await checksum(filePath, progress);
  totals.checksums++;
  checksums[fileName] = hash;
  return hash;
}

function isHashVerified(download: DownloadInfo, hash: Checksums): boolean {
  return (
    (download.sha1 &&
      download.sha1.toLocaleLowerCase() === hash.sha1.toLocaleLowerCase()) ||
    (download.md5 &&
      download.md5.toLocaleLowerCase() === hash.md5.toLocaleLowerCase()) ||
    false
  );
}
