import { assertEquals} from "@std/assert";
import { getDestinationPath } from "../../utils/fileUtils.ts";
import { mockOptions, mockDownloadInfo } from "../mock/mockData.ts";
import { join } from "@std/path";

Deno.test("getDestinationPath creates correct paths with bundle folders enabled", () => {
  const options = { ...mockOptions, bundleFolders: true, productFolders: true };
  const downloadInfo = { ...mockDownloadInfo };

  const result = getDestinationPath(downloadInfo, options);

  const expected = join(
    options.downloadFolder,
    downloadInfo.bundle,
    downloadInfo.name,
    downloadInfo.fileName
  );

  assertEquals(result, expected);
});

Deno.test("getDestinationPath creates correct paths with bundle folders disabled", () => {
  const options = { ...mockOptions, bundleFolders: false, productFolders: true };
  const downloadInfo = { ...mockDownloadInfo };

  const result = getDestinationPath(downloadInfo, options);

  const expected = join(
    options.downloadFolder,
    downloadInfo.name,
    downloadInfo.fileName
  );

  assertEquals(result, expected);
});

Deno.test("getDestinationPath creates correct paths with product folders disabled", () => {
  const options = { ...mockOptions, bundleFolders: true, productFolders: false };
  const downloadInfo = { ...mockDownloadInfo };

  const result = getDestinationPath(downloadInfo, options);

  const expected = join(
    options.downloadFolder,
    downloadInfo.bundle,
    downloadInfo.fileName
  );

  assertEquals(result, expected);
});

Deno.test("getDestinationPath creates correct paths with all folders disabled", () => {
  const options = { ...mockOptions, bundleFolders: false, productFolders: false };
  const downloadInfo = { ...mockDownloadInfo };

  const result = getDestinationPath(downloadInfo, options);

  const expected = join(
    options.downloadFolder,
    downloadInfo.fileName
  );

  assertEquals(result, expected);
});
