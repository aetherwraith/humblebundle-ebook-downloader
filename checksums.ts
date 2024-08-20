import { WalkEntry } from "@std/fs/walk";
import { resolve } from "@std/path";
import { crypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";
import { formatFileSize } from "./utils/formatNumbers.ts";
import { yellow } from "@std/fmt/colors";

const checkSumProgress = {
  start() {
    this.checksumBars[this.file.name] = this.progress.create(
      this.size,
      this.completed,
      {
        file: yellow(`Hashing: ${this.file.name}`),
      },
      { formatValue: formatFileSize },
    );
  },
  transform(chunk, controller) {
    this.completed += chunk.byteLength;
    this.checksumBars[this.file.name].increment(chunk.byteLength);
    controller.enqueue(chunk);
  },
  flush() {
    this.progress.remove(this.checksumBars[this.file.name]);
    this.checksumBars.delete(this.file.name);
  },
};

class ChecksumProgress extends TransformStream {
  constructor(
    size: number,
    file: WalkEntry,
    progress: unknown,
    checksumBars: Set<unknown>,
  ) {
    super({
      ...checkSumProgress,
      size,
      file,
      progress,
      checksumBars,
      completed: 0,
    });
  }
}

async function computeFileHash(
  stream: ReadableStream<Uint8Array>,
) {
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
  file: WalkEntry,
  progress: unknown,
  checksumBars: Set<unknown>,
) {
  const filePath = resolve(file.path);
  const { size } = await Deno.stat(filePath);
  const fileStream = await Deno.open(filePath, { read: true });
  const pipedStreams = fileStream.readable.pipeThrough(
    new ChecksumProgress(size, file, progress, checksumBars),
  );
  return computeFileHash(pipedStreams);
}
