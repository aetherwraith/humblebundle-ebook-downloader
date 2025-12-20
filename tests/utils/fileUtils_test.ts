import { assert, assertEquals } from "@std/assert";
import { exists } from "@std/fs";
import { join, resolve } from "@std/path";
import { clean, deleteEmptyFolders } from "../../utils/fileUtils.ts";
import { DownloadInfo, Options, Totals } from "../../types/general.ts";
import { Checksums } from "../../types/bundle.ts";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("clean - removes extra files and checksums", async () => {
  await withTempDir(async (dir) => {
    const options = { downloadFolder: dir } as Options;
    const totals = { removedFiles: 0, removedChecksums: 0 } as Totals;
    const checksums: Record<string, Checksums> = {
      "keep.txt": { sha1: "abc", md5: "123" },
      "remove.txt": { sha1: "def", md5: "456" },
    };

    // Setup files
    await Deno.writeTextFile(join(dir, "keep.txt"), "keep");
    await Deno.writeTextFile(join(dir, "remove.txt"), "remove");

    // Allowed bundles
    const filteredBundles = [
      { filePath: join(dir, "keep.txt"), fileName: "keep.txt" },
    ] as DownloadInfo[];

    await clean(filteredBundles, checksums, options, totals);

    // Verify files
    assert(await exists(join(dir, "keep.txt")), "keep.txt should exist");
    assertEquals(
      await exists(join(dir, "remove.txt")),
      false,
      "remove.txt should be deleted",
    );

    // Verify checksums
    assert(checksums["keep.txt"], "checksum for keep.txt should remain");
    assertEquals(
      checksums["remove.txt"],
      undefined,
      "checksum for remove.txt should be removed",
    );

    // Verify totals
    assertEquals(totals.removedFiles, 1);
    assertEquals(totals.removedChecksums, 1);
  });
});

Deno.test("deleteEmptyFolders - recursive deletion", async () => {
  await withTempDir(async (dir) => {
    // Structure:
    // /a/b (empty) -> should be deleted
    // /c/d/file.txt -> should NOT be deleted
    // /c/e (empty) -> should be deleted
    // /c -> should remain (contains d)

    const pathA = join(dir, "a");
    const pathB = join(pathA, "b");
    const pathC = join(dir, "c");
    const pathD = join(pathC, "d");
    const pathE = join(pathC, "e");

    await Deno.mkdir(pathB, { recursive: true });
    await Deno.mkdir(pathD, { recursive: true });
    await Deno.mkdir(pathE, { recursive: true });
    await Deno.writeTextFile(join(pathD, "file.txt"), "content");

    await deleteEmptyFolders(dir);

    assertEquals(await exists(pathB), false, "b should be gone");
    assertEquals(
      await exists(pathA),
      false,
      "a should be gone (became empty after b deleted)",
    );
    assertEquals(await exists(pathE), false, "e should be gone");
    assert(await exists(pathD), "d should exist");
    assert(await exists(join(pathD, "file.txt")), "file.txt should exist");
    assert(await exists(pathC), "c should exist");

    // Root dir itself is not deleted by the function effectively because we pass options.downloadFolder usually?
    // Actually the function attempts to delete the passed folder too.
    // In this test helper, `dir` is the root.
    // If `dir` becomes empty (it won't because of C), it would be deleted.
    // But strictly `deleteEmptyFolders` is recursive.
  });
});
