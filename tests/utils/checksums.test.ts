import { assertEquals } from "@std/assert";
import { computeFileHash, checkSignatureMatch } from "../../utils/checksums.ts";
import { MultiBar } from "../../utils/progress.ts";
import { Checksums } from "../../types/bundle.ts";
import { Totals, DownloadInfo } from "../../types/general.ts";

const createMockStream = (content: string): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    }
  });
};

Deno.test("computeFileHash calculates correct SHA-1 and MD5 hashes", async () => {
  // Test with a known string and its expected hashes
  const testContent = "test content";
  const stream = createMockStream(testContent);

  const result = await computeFileHash(stream);

  assertEquals(result.sha1, "d1800d75a15397299e09d49dab86afbda537c35e");
  assertEquals(result.md5, "9473fdd0d880a43c21b7778d34872157");
});

Deno.test("checkSignatureMatch returns false for non-existent files", async () => {
  // Create a mock MultiBar
  const mockProgress = {
    create: () => ({
      setTotal: () => {},
      increment: () => {},
    }),
  } as unknown as MultiBar;

  // Create a mock DownloadInfo
  const downloadInfo: DownloadInfo = {
    date: new Date(),
    bundle: "test-bundle",
    name: "test-file",
    fileName: "test-file.txt",
    downloadPath: "/nonexistent/path",
    filePath: "/nonexistent/path/test-file.txt",
    url: new URL("https://example.com/test-file.txt"),
    sha1: "abcdef1234567890",
    md5: "1234567890abcdef",
    machineName: "test-machine",
    structName: "test-struct",
    file_size: 1024,
  };

  // Create mock checksums and totals
  const checksums: Record<string, Checksums> = {};
  const totals: Totals = {
    bundles: 0,
    checksums: 0,
    checksumsLoaded: 0,
    preFilteredDownloads: 0,
    filteredDownloads: 0,
    removedFiles: 0,
    removedChecksums: 0,
    downloads: 0,
    doneDownloads: 0,
  };

  // Mock Deno.stat to simulate a non-existent file
  const originalStat = Deno.stat;
  Deno.stat = () => Promise.reject(new Error("File not found"));

  try {
    const result = await checkSignatureMatch(downloadInfo, checksums, mockProgress, totals);
    assertEquals(result, false, "Should return false for non-existent files");
  } finally {
    // Restore the original function
    Deno.stat = originalStat;
  }
});
