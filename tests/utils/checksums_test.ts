import { assertEquals } from "@std/assert";
import {
  buildChecksumHashIndex,
  checkSignatureMatch,
  computeFileHash,
  getChecksumCacheKey,
  isHashVerified,
  tryHardlinkExistingFile,
  tryRelocateExistingFile,
  validateFileStructure,
} from "../../utils/checksums.ts";
import { DownloadInfo, Totals } from "../../types/general.ts";
import { Checksums } from "../../types/bundle.ts";
import { MultiBarWrapper } from "../../utils/progressWrapper.ts";

Deno.test("computeFileHash - both sha1 and md5", async () => {
  const content = "Hello World";
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const stream = new Blob([data]).stream();

  const result = await computeFileHash(stream);

  assertEquals(result.sha1, "0a4d55a8d778e5022fab701977c5d840bbc486d0");
  assertEquals(result.md5, "b10a8db164e0754105b7a99be72e3fe5");
});

Deno.test("computeFileHash - selective single hash without stream tee", async () => {
  const data = new TextEncoder().encode("Hello World");

  const sha1Only = await computeFileHash(new Blob([data]).stream(), {
    sha1: true,
    md5: false,
  });
  assertEquals(sha1Only.sha1, "0a4d55a8d778e5022fab701977c5d840bbc486d0");
  assertEquals(sha1Only.md5, undefined);

  const md5Only = await computeFileHash(new Blob([data]).stream(), {
    sha1: false,
    md5: true,
  });
  assertEquals(md5Only.md5, "b10a8db164e0754105b7a99be72e3fe5");
  assertEquals(md5Only.sha1, undefined);
});

Deno.test("getChecksumCacheKey - resolves relative path inside downloadFolder", () => {
  assertEquals(
    getChecksumCacheKey(
      "/tmp/downloads/BundleA/Book1/book.epub",
      "book.epub",
      "/tmp/downloads",
    ),
    "BundleA/Book1/book.epub",
  );
  // Outside downloadFolder falls back to fileName
  assertEquals(
    getChecksumCacheKey("/other/book.epub", "book.epub", "/tmp/downloads"),
    "book.epub",
  );
});

Deno.test("checkSignatureMatch - match SHA1", async () => {
  const download: DownloadInfo = {
    fileName: "test.txt",
    filePath: "/tmp/test.txt", // Mock path, likely won't be read because checksums cache is hit?
    // Actually checkSignatureMatch checks existence first.
    // We should probably mock exists or use a real file. Use a real file for simplicity in integration.
    sha1: "0a4d55a8d778e5022fab701977c5d840bbc486d0",
  } as DownloadInfo;

  const checksums: Record<string, Checksums> = {
    "test.txt": {
      sha1: "0a4d55a8d778e5022fab701977c5d840bbc486d0",
      md5: "b10a8db164e0754105b7a99be72e3fe5",
    },
  };

  const progress = {
    log: () => {},
  } as unknown as MultiBarWrapper;

  const totals = { checksums: 0 } as Totals;

  // We mock Deno.stat and Deno.open/exists?
  // checkSignatureMatch first calls `exists(download.filePath)`.
  // If we can't easily mock `exists`, we should create a dummy file.

  const tempFile = await Deno.makeTempFile();
  try {
    const updatedDownload = {
      ...download,
      filePath: tempFile,
      fileName: "test_file",
    };
    const updatedChecksums = { "test_file": checksums["test.txt"] };

    // Case 1: Checksums cached
    const result = await checkSignatureMatch(
      updatedDownload,
      updatedChecksums,
      progress,
      totals,
    );
    assertEquals(result, true);
  } finally {
    await Deno.remove(tempFile).catch(() => {});
  }
});

Deno.test("isHashVerified - validates sha1 and md5 with case insensitivity", () => {
  const download: DownloadInfo = {
    fileName: "test.epub",
    filePath: "/tmp/test.epub",
    sha1: "0A4D55A8D778E5022FAB701977C5D840BBC486D0",
    md5: "B10A8DB164E0754105B7A99BE72E3FE5",
  } as DownloadInfo;

  const hash: Checksums = {
    sha1: "0a4d55a8d778e5022fab701977c5d840bbc486d0",
    md5: "b10a8db164e0754105b7a99be72e3fe5",
  };

  assertEquals(isHashVerified(download, hash), true);

  // Mismatched
  const wrongHash: Checksums = {
    sha1: "wrong_sha1",
    md5: "wrong_md5",
  };
  assertEquals(isHashVerified(download, wrongHash), false);
});

Deno.test("isHashVerified - handles swapped sha1/md5 and partial matches from Humble Bundle API", () => {
  const actualHash: Checksums = {
    sha1: "0a4d55a8d778e5022fab701977c5d840bbc486d0",
    md5: "b10a8db164e0754105b7a99be72e3fe5",
  };

  // Case 1: API stored MD5 inside the sha1 field and SHA1 inside the md5 field
  const swappedDownload = {
    fileName: "swapped.zip",
    filePath: "/tmp/swapped.zip",
    sha1: "b10a8db164e0754105b7a99be72e3fe5",
    md5: "0a4d55a8d778e5022fab701977c5d840bbc486d0",
  } as DownloadInfo;
  assertEquals(isHashVerified(swappedDownload, actualHash), true);

  // Case 2: API has outdated sha1, but md5 is still accurate
  const staleSha1Download = {
    fileName: "stale_sha1.zip",
    filePath: "/tmp/stale_sha1.zip",
    sha1: "48540ac721a87f14c5e60a01f1e81d3043059269",
    md5: "b10a8db164e0754105b7a99be72e3fe5",
  } as DownloadInfo;
  assertEquals(isHashVerified(staleSha1Download, actualHash), true);
});

Deno.test("checkSignatureMatch - returns false if file does not exist", async () => {
  const download: DownloadInfo = {
    fileName: "non_existent.epub",
    filePath: "/tmp/non_existent_file_path_12345.epub",
    sha1: "abc",
  } as DownloadInfo;

  const checksums: Record<string, Checksums> = {};
  const progress = { log: () => {} } as unknown as MultiBarWrapper;
  const totals = { checksums: 0 } as Totals;

  const result = await checkSignatureMatch(download, checksums, progress, totals);
  assertEquals(result, false);
});

Deno.test("checkSignatureMatch - tracks hashErrors and prevents re-downloading when file on disk matches previously recorded mismatch", async () => {
  const tempFile = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(tempFile, "Hello World");
    const stat = await Deno.stat(tempFile);

    const download: DownloadInfo = {
      fileName: "mismatched_api_book.epub",
      filePath: tempFile,
      // API has a completely wrong/stale SHA-1 that doesn't match "Hello World"
      sha1: "ffffffffffffffffffffffffffffffffffffffff",
    } as DownloadInfo;

    const checksums: Record<string, Checksums> = {};
    const progress = {
      log: () => {},
      create: () => ({ increment: () => {} }),
      remove: () => {},
    } as unknown as MultiBarWrapper;
    const totals = { checksums: 0, hashErrors: 0 } as Totals;

    // 1st check: file is not in checksums.json yet, hashes disk file, sees mismatch against API -> records hashErrors = 1, returns false
    const firstCheck = await checkSignatureMatch(
      download,
      checksums,
      progress,
      totals,
    );
    assertEquals(firstCheck, false);
    assertEquals(totals.hashErrors, 1);
    assertEquals(checksums["mismatched_api_book.epub"]?.hashErrors, 1);
    assertEquals(checksums["mismatched_api_book.epub"]?.verifiedSize, stat.size);

    // 2nd check (next run, or if same file on disk): sees hashErrors > 0 and file on disk still matches cached hash, size & mtime -> returns true (zero-read fast path!)
    const checksumsBeforeSecond = totals.checksums;
    const secondCheck = await checkSignatureMatch(
      download,
      checksums,
      progress,
      totals,
    );
    assertEquals(secondCheck, true);
    assertEquals(totals.hashErrors, 1); // Did not increment again
    assertEquals(totals.checksums, checksumsBeforeSecond); // Fast path skipped re-hashing from disk!
  } finally {
    await Deno.remove(tempFile).catch(() => {});
  }
});

Deno.test("tryRelocateExistingFile - moves verified file and its sidecars from old path to new path without re-downloading", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const oldPath = `${tempDir}/old_folder/book.epub`;
    const oldOpf = `${tempDir}/old_folder/book.opf`;
    const oldCover = `${tempDir}/old_folder/book.jpg`;
    const newDir = `${tempDir}/NewBundle/NewProduct`;
    const newPath = `${newDir}/Human Title.epub`;
    const newOpf = `${newDir}/Human Title.opf`;
    const newCover = `${newDir}/Human Title.jpg`;

    await Deno.mkdir(`${tempDir}/old_folder`, { recursive: true });
    await Deno.writeTextFile(oldPath, "Hello World");
    await Deno.writeTextFile(oldOpf, "<package/>");
    await Deno.writeTextFile(oldCover, "jpeg-bytes");

    const checksums: Record<string, Checksums> = {
      "old_folder/book.epub": {
        sha1: "0a4d55a8d778e5022fab701977c5d840bbc486d0",
      },
    };

    const download: DownloadInfo = {
      fileName: "Human Title.epub",
      downloadPath: newDir,
      filePath: newPath,
      sha1: "0a4d55a8d778e5022fab701977c5d840bbc486d0",
    } as DownloadInfo;

    const progress = { log: () => {}, debug: () => {} } as unknown as MultiBarWrapper;
    const totals = { movedFiles: 0 } as Totals;
    const hashIndex = buildChecksumHashIndex(checksums);

    const relocated = await tryRelocateExistingFile(
      download,
      checksums,
      progress,
      totals,
      tempDir,
      false,
      hashIndex,
    );
    assertEquals(relocated, true);
    assertEquals(totals.movedFiles, 1);
    assertEquals(await Deno.readTextFile(newPath), "Hello World");
    assertEquals(await Deno.readTextFile(newOpf), "<package/>");
    assertEquals(await Deno.readTextFile(newCover), "jpeg-bytes");
    assertEquals(
      checksums["NewBundle/NewProduct/Human Title.epub"]?.sha1,
      "0a4d55a8d778e5022fab701977c5d840bbc486d0",
    );
    assertEquals(checksums["old_folder/book.epub"], undefined);
    assertEquals(
      hashIndex.get("0a4d55a8d778e5022fab701977c5d840bbc486d0")?.has(
        "NewBundle/NewProduct/Human Title.epub",
      ),
      true,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("checkSignatureMatch - invalidates cached hash when file size on disk differs from verifiedSize", async () => {
  const tempFile = await Deno.makeTempFile();
  try {
    // Write truncated/corrupted content ("Hello" instead of "Hello World")
    await Deno.writeTextFile(tempFile, "Hello");

    const download: DownloadInfo = {
      fileName: "truncated.epub",
      filePath: tempFile,
      sha1: "0a4d55a8d778e5022fab701977c5d840bbc486d0", // Expected SHA-1 of "Hello World"
    } as DownloadInfo;

    const checksums: Record<string, Checksums> = {
      "truncated.epub": {
        sha1: "0a4d55a8d778e5022fab701977c5d840bbc486d0",
        verifiedSize: 11, // Recorded when it was 11 bytes ("Hello World"), but disk now has 5 bytes ("Hello")
      },
    };

    const progress = {
      log: () => {},
      debug: () => {},
      create: () => ({ increment: () => {} }),
      remove: () => {},
    } as unknown as MultiBarWrapper;
    const totals = { checksums: 0, hashErrors: 0 } as Totals;

    const result = await checkSignatureMatch(download, checksums, progress, totals);
    assertEquals(result, false);
    assertEquals(totals.checksums > 0, true);
  } finally {
    await Deno.remove(tempFile).catch(() => {});
  }
});

Deno.test("tryHardlinkExistingFile - hardlinks verified duplicate without deleting source", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const srcDir = `${tempDir}/Bundle1/Book`;
    const dstDir = `${tempDir}/Bundle2/Book`;
    const srcPath = `${srcDir}/book.epub`;
    const dstPath = `${dstDir}/book.epub`;

    await Deno.mkdir(srcDir, { recursive: true });
    await Deno.writeTextFile(srcPath, "Hello World");

    const checksums: Record<string, Checksums> = {
      "Bundle1/Book/book.epub": {
        sha1: "0a4d55a8d778e5022fab701977c5d840bbc486d0",
        verifiedSize: 11,
      },
    };
    const hashIndex = buildChecksumHashIndex(checksums);
    const progress = { log: () => {}, debug: () => {} } as unknown as MultiBarWrapper;
    const totals = { linkedFiles: 0 } as Totals;

    const download: DownloadInfo = {
      fileName: "book.epub",
      downloadPath: dstDir,
      filePath: dstPath,
      sha1: "0a4d55a8d778e5022fab701977c5d840bbc486d0",
    } as DownloadInfo;

    const linked = await tryHardlinkExistingFile(
      download,
      checksums,
      progress,
      totals,
      tempDir,
      false,
      hashIndex,
    );
    assertEquals(linked, true);
    assertEquals(totals.linkedFiles, 1);
    assertEquals(await Deno.readTextFile(srcPath), "Hello World");
    assertEquals(await Deno.readTextFile(dstPath), "Hello World");
    assertEquals(
      checksums["Bundle2/Book/book.epub"]?.sha1,
      "0a4d55a8d778e5022fab701977c5d840bbc486d0",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("validateFileStructure - validates PDF and ZIP/EPUB headers and trailers", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const validPdf = `${tempDir}/valid.pdf`;
    const truncatedPdf = `${tempDir}/truncated.pdf`;
    const validEpub = `${tempDir}/valid.epub`;
    const truncatedEpub = `${tempDir}/truncated.epub`;

    await Deno.writeTextFile(validPdf, "%PDF-1.7\n1 0 obj\nendobj\n%%EOF\n");
    await Deno.writeTextFile(truncatedPdf, "%PDF-1.7\n1 0 obj\ntruncated");

    // Minimal valid empty PKZIP End of Central Directory (22 bytes)
    const emptyZipBytes = new Uint8Array(22);
    emptyZipBytes[0] = 0x50;
    emptyZipBytes[1] = 0x4b;
    emptyZipBytes[2] = 0x05;
    emptyZipBytes[3] = 0x06;
    await Deno.writeFile(validEpub, emptyZipBytes);

    // Local file header without EOCD trailer (truncated archive)
    const badZipBytes = new Uint8Array(30);
    badZipBytes[0] = 0x50;
    badZipBytes[1] = 0x4b;
    badZipBytes[2] = 0x03;
    badZipBytes[3] = 0x04;
    await Deno.writeFile(truncatedEpub, badZipBytes);

    assertEquals((await validateFileStructure(validPdf)).valid, true);
    assertEquals((await validateFileStructure(truncatedPdf)).valid, false);
    assertEquals((await validateFileStructure(validEpub)).valid, true);
    assertEquals((await validateFileStructure(truncatedEpub)).valid, false);
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});
