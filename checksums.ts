import { WalkEntry } from "@std/fs/walk";
import { resolve } from "@std/path";
import { crypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";
import { formatFileSize } from "./utils/formatNumbers.ts";
import { yellow } from "@std/fmt/colors";

export async function checksum(
  file: WalkEntry,
  checksumProgress: any,
  checksumBars: Set<unknown>,
) {
  const size = (await Deno.stat(resolve(file.path))).size;

  using hashMe = await Deno.open(resolve(file.path), { read: true });
  const bob = hashMe.readable.pipeThrough(
    new ChecksumProgress(size, file, checksumProgress, checksumBars),
  );

  const [shaStream, md5Stream] = bob.tee();

  const [shaHashBuffer, md5HashBuffer] = await Promise.all([
    crypto.subtle.digest("SHA-1", shaStream),
    crypto.subtle.digest("MD5", md5Stream),
  ]);

  const sha1 = encodeHex(shaHashBuffer);
  const md5 = encodeHex(md5HashBuffer);

  return { sha1, md5 };
}

const progress = {
  start() {
    this.checksumBars[this.file.name] = this.checksumProgress.create(
      this.size,
      this.completed,
      {
        file: yellow(`Hashing: ${this.file.name}`),
      },
      { formatValue: formatFileSize },
    );
  },
  async transform(chunk, controller) {
    this.completed += chunk.byteLength;
    this.checksumBars[this.file.name].increment(chunk.byteLength);
    controller.enqueue(chunk);
  },
  flush() {
    this.checksumProgress.remove(this.checksumBars[this.file.name]);
    this.checksumBars.delete(this.file.name);
  },
};

class ChecksumProgress extends TransformStream {
  constructor(
    size: number,
    file: WalkEntry,
    checksumProgress,
    checksumBars,
  ) {
    super({
      ...progress,
      size,
      file,
      checksumProgress,
      checksumBars,
      completed: 0,
    });
  }
}
