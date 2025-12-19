import { assertEquals } from "@std/assert";
import { computeFileHash, checkSignatureMatch } from "../../utils/checksums.ts";
import { DownloadInfo, Totals } from "../../types/general.ts";
import { Checksums } from "../../types/bundle.ts";
import { MultiBarWrapper } from "../../utils/progressWrapper.ts";

Deno.test("computeFileHash", async () => {
  const content = "Hello World";
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  // Create a stream from the data
  const stream = new Blob([data]).stream();

  const result = await computeFileHash(stream);

  // Expected hashes for "Hello World"
  // SHA1: 0a4d55a8d778e5022fab701977c5d840bbc486d0
  // MD5: b10a8db164e0754105b7a99be72e3fe5

  assertEquals(result.sha1, "0a4d55a8d778e5022fab701977c5d840bbc486d0");
  assertEquals(result.md5, "b10a8db164e0754105b7a99be72e3fe5");
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
      md5: "b10a8db164e0754105b7a99be72e3fe5"
    }
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
     const updatedDownload = { ...download, filePath: tempFile, fileName: "test_file" };
     const updatedChecksums = { "test_file": checksums["test.txt"] };

     // Case 1: Checksums cached
     const result = await checkSignatureMatch(updatedDownload, updatedChecksums, progress, totals);
     assertEquals(result, true);

  } finally {
     await Deno.remove(tempFile).catch(() => {});
  }
});
