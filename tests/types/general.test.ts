import { assertType } from "@std/testing/types";
import { Options, Totals, DownloadInfo } from "../../types/general.ts";

Deno.test("Options type structure validation", () => {
  // Create a valid Options object
  const options: Options = {
    _: ["command"],
    dedup: true,
    bundleFolders: true,
    productFolders: true,
    humanFileNames: false,
    parallel: 4,
    format: ["pdf", "epub"],
    platform: ["windows", "mac"],
    command: "all",
    authToken: "test_token",
    downloadFolder: "/download/path",
  };

  // Test that the object conforms to the Options type
  assertType<Options>(options);
});

Deno.test("Totals type structure validation", () => {
  // Create a valid Totals object
  const totals: Totals = {
    bundles: 10,
    checksums: 20,
    checksumsLoaded: 15,
    preFilteredDownloads: 50,
    filteredDownloads: 30,
    removedFiles: 5,
    removedChecksums: 5,
    downloads: 25,
    doneDownloads: 25,
  };

  // Test that the object conforms to the Totals type
  assertType<Totals>(totals);
});

Deno.test("DownloadInfo type structure validation", () => {
  // Create a valid DownloadInfo object
  const downloadInfo: DownloadInfo = {
    date: new Date("2023-01-01"),
    bundle: "humble_bundle_1",
    name: "Test Game",
    fileName: "test_game.exe",
    downloadPath: "/download/path",
    filePath: "/download/path/test_game.exe",
    url: new URL("https://example.com/download"),
    sha1: "abcdef1234567890",
    md5: "1234567890abcdef",
    machineName: "test_game",
    structName: "windows",
    file_size: 1048576,
  };

  // Test that the object conforms to the DownloadInfo type
  assertType<DownloadInfo>(downloadInfo);
});
