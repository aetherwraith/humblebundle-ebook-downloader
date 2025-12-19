
import { clean, walkExistingFiles } from "../utils/fileUtils.ts";
import { DownloadInfo, Options, Totals } from "../types/general.ts";
import { Checksums } from "../types/bundle.ts";
import { resolve } from "@std/path";

// Mock Deno.remove to avoid actual deletion during benchmark
const originalRemove = Deno.remove;
Deno.remove = () => Promise.resolve();

// Mock walkExistingFiles to return a large number of files
const MOCK_FILE_COUNT = 10000;
const MOCK_DOWNLOAD_COUNT = 5000;

async function* mockWalkExistingFiles(_options: Options) {
  for (let i = 0; i < MOCK_FILE_COUNT; i++) {
    yield {
      path: resolve(`download/file${i}.epub`),
      name: `file${i}.epub`,
      isFile: true,
      isDirectory: false,
      isSymlink: false,
    };
  }
}

// Check if we can overwrite the export, otherwise we might need a different approach regarding modules.
// Since we are importing, we can't easily mock internal functions of the module without a DI pattern or similar.
// However, for this benchmark, we can reimplement the logic we are testing or copy-paste it here if we want to isolate it completely,
// BUT we want to test the actual fileUtils.ts code.
// The issue is `walkExistingFiles` is exported but also used internally by `clean`.
// If `clean` calls `walkExistingFiles` directly from the same module, mocking it via import replacement won't work in ES modules easily.
// A simple workaround for this benchmark is to create a modified version of `clean` in this script that calls our mock,
// OR (better) we assume the user accepts we might need to modify `utils/fileUtils.ts` slightly to accept a walker or we temporary modify it.

// WAIT. The simplest way to benchmark the *internal logic* change I'm about to make (array.some vs Set) is to
// just synthesize the arrays in this test and run the comparison logic here, assuming I will copy that logic to the main file.
// modifying the main file to be testable is also a good optimization.

// Let's modify the plan slightly: I will modify `clean` to accept an optional file walker or list of files for testing.
// Actually, `clean` takes `filteredBundles` and `checksums`. The file iteration is the external part.
// The current implementation of `clean` calls `walkExistingFiles` directly.

// New strategy for Benchmark:
// I'll create a standalone benchmark that simulates the workload:
// 1. Create a large array of "Existing Files"
// 2. Create a large array of "Allowed Downloads"
// 3. Measure time to find which files to delete using the OLD logic (O(N*M))
// 4. Measure time to find which files to delete using the NEW logic (Set based)

const existingFiles = Array.from({ length: MOCK_FILE_COUNT }, (_, i) => ({
  path: `/abs/path/to/download/file${i}.epub`,
  name: `file${i}.epub`,
}));

const allowedDownloads: DownloadInfo[] = Array.from({ length: MOCK_DOWNLOAD_COUNT }, (_, i) => ({
    bundle: "bundle",
    name: "name",
    machineName: "machine",
    fileName: `file${i * 2}.epub`, // Only even files are allowed
    downloadPath: "/abs/path/to/download",
    filePath: `/abs/path/to/download/file${i * 2}.epub`,
    url: new URL("http://example.com"),
    date: new Date(),
    file_size: 100,
} as DownloadInfo));


console.log(`Benchmarking with ${MOCK_FILE_COUNT} files and ${MOCK_DOWNLOAD_COUNT} allowed downloads.`);

// OLD ALG
const startOld = performance.now();
let removedOld = 0;
for (const file of existingFiles) {
    if (
        !allowedDownloads.some((download) =>
             file.path.toLowerCase() === download.filePath.toLowerCase()
        )
    ) {
        removedOld++;
    }
}
const endOld = performance.now();
console.log(`Old Algorithm: ${(endOld - startOld).toFixed(2)}ms, found ${removedOld} to remove.`);

// NEW ALG
const startNew = performance.now();
const allowedPaths = new Set(allowedDownloads.map(d => d.filePath.toLowerCase()));
let removedNew = 0;
for (const file of existingFiles) {
    if (!allowedPaths.has(file.path.toLowerCase())) {
        removedNew++;
    }
}
const endNew = performance.now();
console.log(`New Algorithm: ${(endNew - startNew).toFixed(2)}ms, found ${removedNew} to remove.`);

