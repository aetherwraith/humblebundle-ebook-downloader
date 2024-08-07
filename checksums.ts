import { WalkEntry } from "@std/fs/walk";
import { createHash } from "node:crypto";
import { resolve } from "@std/path";
import { MultiProgressBar, renderOptions } from "https://jsr.io/@deno-library/progress/1.4.9/multi.ts";
import * as log from "@std/log";

export async function checksum(
  file: WalkEntry,
  checksumProgress: MultiProgressBar,
  checksumBars
) {
  const shasum = createHash("sha1");
  const md5sum = createHash("md5");
  const size = (await Deno.stat(resolve(file.path))).size;
  let completed = 0;
  checksumBars[file.name] = { completed, total: size, text: file.name };
  await checksumProgress.render(Object.values(checksumBars));

  using hashMe = await Deno.open(resolve(file.path), { read: true });
  for await (const chunk of hashMe.readable) {
    shasum.update(chunk);
    md5sum.update(chunk);
    completed += chunk.byteLength;
    checksumBars[file.name] = { completed, total: size, text: file.name };
    await checksumProgress.render(Object.values(checksumBars));
  }

  console.log(checksumBars.size)
  delete checksumBars[file.name];
  console.log(checksumBars.size)


  return { sha1: shasum.digest("hex"), md5: md5sum.digest("hex") };
}
