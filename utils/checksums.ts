import { isEql } from "@opentf/std";
import { crypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";
import { yellow } from "@std/fmt/colors";
import { exists } from "@std/fs/exists";
import { resolve } from "@std/path";
import type { MultiBar } from "cli-progress";
import { DownloadInfo } from "./orders.ts";
import { StreamProgress } from "./streamProgress.ts";
import { Checksums, Totals } from "./types.ts";

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
  totals: Totals,
): Promise<boolean> {
  if (!(await exists(download.filePath))) return false;

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
      isEql(
        download.sha1.toLocaleLowerCase(),
        hash.sha1.toLocaleLowerCase(),
      )) ||
    (download.md5 &&
      isEql(download.md5.toLocaleLowerCase(), hash.md5.toLocaleLowerCase())) ||
    false
  );
}
