import { yellow } from "@std/fmt/colors";
import { basename, extname, resolve } from "@std/path";
import sanitizeFilename from "sanitize-filename";
import { normalizeFormat } from "./generic.ts";
import { MultiBar } from "./progress.ts";

import {
  Bundle,
  DownloadStruct,
  Platform,
  SubProduct,
} from "../types/bundle.ts";
import { DownloadInfo, Options, Totals } from "../types/general.ts";

/**
 * Create download information from bundle data
 */
function createDownloadInfo(
  bundle: Bundle,
  subProduct: SubProduct,
  struct: DownloadStruct,
  options: Options,
  date: Date,
): DownloadInfo {
  // Parse URL once
  const url = new URL(struct.url.web);
  const urlBasename = basename(url.pathname);

  // Generate filename based on options
  const fileName = sanitizeFilename(
    options.humanFileNames
      ? `${subProduct.human_name}${extname(urlBasename)}`
      : urlBasename,
  );

  // Precompute sanitized names once to avoid repeated sanitization
  const sanitizedBundleName = options.bundleFolders
    ? sanitizeFilename(bundle.product.human_name)
    : "";

  const sanitizedProductName = options.productFolders
    ? sanitizeFilename(subProduct.human_name)
    : "";

  // Build download path according to folder structure options
  const downloadPath = resolve(
    options.downloadFolder,
    sanitizedBundleName,
    sanitizedProductName,
  );

  return {
    bundle: bundle.product.human_name,
    name: subProduct.human_name,
    machineName: subProduct.machine_name,
    fileName,
    downloadPath,
    filePath: resolve(downloadPath, fileName),
    url,
    sha1: struct.sha1,
    md5: struct.md5,
    structName: struct.name ?? fileName,
    date,
    file_size: struct.file_size,
  };
}

/**
 * Check if a download is a duplicate based on filename or checksums
 */
function isDuplicateDownload(
  downloads: DownloadInfo[],
  downloadInfo: DownloadInfo,
  struct: DownloadStruct,
  options: Options,
): boolean {
  // Early return if deduplication is disabled
  if (!options.dedup) return false;

  // Check if we have valid checksums to compare
  const hasValidChecksums = struct.sha1 && struct.md5;
  const lowerFileName = downloadInfo.fileName.toLocaleLowerCase();
  const lowerSha1 = struct.sha1?.toLocaleLowerCase();
  const lowerMd5 = struct.md5?.toLocaleLowerCase();

  // Use find instead of some for potential better performance
  // when a match is found early in large arrays
  return downloads.some((elem) => {
    // First check filename match which is a simple string comparison
    if (elem.fileName.toLocaleLowerCase() === lowerFileName) {
      return true;
    }

    // Then check for checksum match if we have valid checksums
    return hasValidChecksums &&
      elem.sha1 &&
      elem.md5 &&
      lowerSha1 === elem.sha1.toLocaleLowerCase() &&
      lowerMd5 === elem.md5.toLocaleLowerCase();
  });
}

/**
 * Filter bundles to create a list of downloadable items
 */
export function filterBundles(
  bundles: Bundle[],
  options: Options,
  totals: Totals,
  progress: MultiBar,
): DownloadInfo[] {
  progress.log(
    `${
      yellow(bundles.length.toString())
    } bundles containing downloadable items`,
  );

  // Pre-allocate with a reasonable capacity to avoid frequent reallocations
  // Estimate 2 downloads per bundle as a heuristic
  const downloads: DownloadInfo[] = [];
  // Track lowercase paths to avoid repeated toLowerCase calls
  const lowerFilePaths = new Set<string>();

  // Cache bundle creation date objects to avoid repeated Date instantiation
  const bundleDates = new Map<Bundle, Date>();

  for (const bundle of bundles) {
    // Get or create the bundle date once per bundle
    const bundleDate = bundleDates.get(bundle) ??
      (bundleDates.set(bundle, new Date(bundle.created)),
        bundleDates.get(bundle)!);

    for (const subProduct of bundle.subproducts) {
      // Filter platform downloads once per subproduct
      const platformDownloads = subProduct.downloads.filter((elem) =>
        options.platform.includes(elem.platform)
      );

      if (platformDownloads.length === 0) continue;

      for (const download of platformDownloads) {
        for (const struct of download.download_struct) {
          if (!struct.url) continue;

          totals.preFilteredDownloads++;

          // Parse date once per struct
          const date = struct.uploaded_at
            ? new Date(struct.uploaded_at)
            : bundleDate;

          const downloadInfo = createDownloadInfo(
            bundle,
            subProduct,
            struct,
            options,
            date,
          );

          // Convert to lowercase once
          const lowerFilePath = downloadInfo.filePath.toLocaleLowerCase();

          // Check if this is a duplicate download
          if (isDuplicateDownload(downloads, downloadInfo, struct, options)) {
            continue;
          }

          // Check for path collision using Set for O(1) lookup
          if (lowerFilePaths.has(lowerFilePath)) {
            continue;
          }

          // Add to our collections
          downloads.push(downloadInfo);
          lowerFilePaths.add(lowerFilePath);
        }
      }
    }
  }

  totals.filteredDownloads = downloads.length;

  // Sort by file size in descending order (largest first)
  // With name as a fallback for files of the same size
  return downloads.sort((a, b) => {
    // First compare by file size (descending)
    if (a.file_size !== b.file_size) {
      return (b.file_size ?? 0) - (a.file_size ?? 0);
    }
    // Fall back to name for files of the same size (ascending)
    return a.name.localeCompare(b.name);
  });
}

/**
 * Filter bundles to create a list of ebook downloads
 * Priority of format to download cbz → epub → pdf_hd → pdf → mobi
 */
export function filterEbooks(
  bundles: Bundle[],
  options: Options,
  totals: Totals,
  progress: MultiBar,
): DownloadInfo[] {
  progress.log(
    `${yellow(bundles.length.toString())} bundles containing ebooks`,
  );

  // We'll use a Map for faster lookups by machine name
  const downloadMap = new Map<string, DownloadInfo>();
  // Track lowercase paths to avoid repeated toLowerCase calls
  const lowerFilePaths = new Set<string>();
  // Cache format normalization results
  const formatCache = new Map<string, string>();
  // Cache bundle creation date objects
  const bundleDates = new Map<Bundle, Date>();

  for (const bundle of bundles) {
    // Get or create the bundle date once per bundle
    const bundleDate = bundleDates.get(bundle) ??
      (bundleDates.set(bundle, new Date(bundle.created)),
        bundleDates.get(bundle)!);

    for (const subProduct of bundle.subproducts) {
      // Early skip if no downloads for this product
      if (!subProduct.downloads?.length) continue;

      // Lowercase machine name once per subproduct
      const lowerMachineName = subProduct.machine_name.toLocaleLowerCase();

      // Filter ebook downloads once per subproduct
      const ebookDownloads = subProduct.downloads.filter((elem) =>
        elem.platform === Platform.Ebook
      );

      if (ebookDownloads.length === 0) continue;

      for (const format of options.format) {
        for (const download of ebookDownloads) {
          for (const struct of download.download_struct) {
            // Skip if missing required fields
            if (!struct.name || !struct.url) continue;

            // Get or compute normalized format
            let normalizedFormat = formatCache.get(struct.name);
            if (normalizedFormat === undefined) {
              normalizedFormat = normalizeFormat(struct.name);
              formatCache.set(struct.name, normalizedFormat);
            }

            // Skip if format doesn't match
            if (normalizedFormat !== format) continue;

            totals.preFilteredDownloads++;

            // Get upload date, using cached bundle date when needed
            const uploadDate = struct.uploaded_at
              ? new Date(struct.uploaded_at)
              : bundleDate;

            // Lookup existing download by machine name
            const existing = options.dedup
              ? downloadMap.get(lowerMachineName)
              : undefined;

            // Create a lowercase struct name for comparison
            const lowerStructName = struct.name.toLocaleLowerCase();

            // Determine if we should keep this version
            const shouldKeep = !existing || (
              uploadDate > existing.date &&
              lowerStructName === existing.structName.toLocaleLowerCase()
            );

            if (shouldKeep) {
              const downloadInfo = createDownloadInfo(
                bundle,
                subProduct,
                struct,
                options,
                uploadDate,
              );

              // Check for path collision
              const lowerFilePath = downloadInfo.filePath.toLocaleLowerCase();
              if (
                lowerFilePaths.has(lowerFilePath) &&
                !existing
              ) { // If replacing existing, we'll remove its path later
                continue;
              }

              // If replacing an existing entry, remove its path from tracking
              if (existing) {
                lowerFilePaths.delete(existing.filePath.toLocaleLowerCase());
              }

              // Update our collections
              downloadMap.set(lowerMachineName, downloadInfo);
              lowerFilePaths.add(lowerFilePath);
            }
          }
        }
      }
    }
  }

  // Convert map values to array
  const downloads = Array.from(downloadMap.values());
  totals.filteredDownloads = downloads.length;

  // Sort by file size in descending order (largest first)
  // With name as a fallback for files of the same size
  return downloads.sort((a, b) => {
    // First compare by file size (descending)
    if (a.file_size !== b.file_size) {
      return (b.file_size ?? 0) - (a.file_size ?? 0);
    }
    // Fall back to name for files of the same size (ascending)
    return a.name.localeCompare(b.name);
  });
}
