import { yellow } from "@std/fmt/colors";
import { basename, extname, resolve } from "@std/path";
import { MultiBarWrapper, progressDebug } from "./progressWrapper.ts";
import {
  compileItemFilters,
  COMPOUND_EXTENSIONS,
  detectAudioFormat,
  detectVideoQuality,
  expandFormatPreferences,
  getVideoQualityScore,
  normalizeAudioFormat,
  normalizeFormat,
  normalizeVideoQuality,
  resolveOutputTemplate,
  sanitizeFilename,
  sortDownloads,
  stripFileExtension,
} from "./generic.ts";
import { DEFAULT_AUDIO_FORMATS } from "./constants.ts";
import {
  Bundle,
  Download as BundleDownload,
  DownloadStruct,
  Platform,
  SubProduct,
} from "../types/bundle.ts";
import { DownloadInfo, Options, Totals } from "../types/general.ts";

const VIDEO_COMPANION_RE =
  /\b(subtitles?|supplement|captions?)\b|[_-](subtitles?|supplement|captions?)(?:[_.-]|$)|\.(srt|vtt|ass|sub)$/i;
const VIDEO_MULTIPART_RE =
  /(?:^|[_.\s-])(part|disc|disk|vol(?:ume)?)\s*0*\d+(?:[_.\s-]|$)/i;
const VIDEO_FILE_EXT_RE = /\.(mp4|mkv|avi|mov|webm|m4v|mpg|mpeg|wmv|flv)$/i;

function isVideoCompanionStruct(s: DownloadStruct): boolean {
  const label = `${s.name ?? ""} ${s.url?.web ?? ""}`;
  return VIDEO_COMPANION_RE.test(label);
}

/**
 * Filters a list of video `DownloadStruct`s according to the user's `videoQuality` preferences
 * (e.g. `["1080p", "best"]` -> picks 1080p if available, otherwise highest quality/largest file_size),
 * while preserving companion subtitle/supplement archives and multi-part course archives.
 *
 * @param structs DownloadStruct candidates on a video download
 * @param videoQualities Ordered array of quality preferences
 * @param dedup Whether to stop at the first matched preference tier (default true)
 * @returns Selected DownloadStruct array
 */
export function selectVideoStructs(
  structs: DownloadStruct[],
  videoQualities: string[],
  dedup = true,
): DownloadStruct[] {
  const validStructs = structs.filter((s) => Boolean(s.url?.web));
  if (validStructs.length === 0) return [];

  const preferences = videoQualities.length > 0
    ? videoQualities.map(normalizeVideoQuality)
    : ["best"];

  if (!dedup && preferences.length === 1 && preferences[0] === "best") {
    // When --no-dedup is used without specific quality filters, return all video structs
    return validStructs;
  }

  // Separate subtitle/course-supplement companion files so quality dedup doesn't discard them
  const companions = validStructs.length > 1
    ? validStructs.filter((s) => isVideoCompanionStruct(s))
    : [];
  const primaryStructs = companions.length > 0 &&
      companions.length < validStructs.length
    ? validStructs.filter((s) => !isVideoCompanionStruct(s))
    : validStructs;

  // Preserve multi-part untagged archives (e.g. `course_part1.zip` + `course_part2.zip`)
  const anyHasResolution = primaryStructs.some((s) =>
    Boolean(detectVideoQuality(`${s.name ?? ""} ${s.url?.web ?? ""}`))
  );
  if (
    dedup &&
    !anyHasResolution &&
    primaryStructs.length > 1 &&
    primaryStructs.every((s) =>
      VIDEO_MULTIPART_RE.test(`${s.name ?? ""} ${s.url?.web ?? ""}`)
    )
  ) {
    return [...primaryStructs, ...companions];
  }

  const matchesQuality = (s: DownloadStruct, target: string): boolean => {
    const label = `${s.name ?? ""} ${s.url?.web ?? ""}`;
    const detected = detectVideoQuality(label);
    if (detected === target) return true;
    // Allow "hd" preference to match 1080p or 720p if no literal "HD" label exists
    if (target === "hd" && (detected === "1080p" || detected === "720p")) {
      return true;
    }
    if (target === "sd" && (detected === "480p" || detected === "360p")) {
      return true;
    }
    return false;
  };

  const getExtremeStruct = (mode: "best" | "worst"): DownloadStruct => {
    let bestStruct = primaryStructs[0];
    let bestScore = getVideoQualityScore(
      bestStruct.file_size,
      bestStruct.name,
      bestStruct.url?.web,
    );
    for (let i = 1; i < primaryStructs.length; i++) {
      const candidate = primaryStructs[i];
      const score = getVideoQualityScore(
        candidate.file_size,
        candidate.name,
        candidate.url?.web,
      );
      if (mode === "best" ? score > bestScore : score < bestScore) {
        bestScore = score;
        bestStruct = candidate;
      }
    }
    return bestStruct;
  };

  const selected: DownloadStruct[] = [];
  const addedSet = new Set<DownloadStruct>();

  for (const pref of preferences) {
    let matched: DownloadStruct[] = [];
    if (pref === "best" || pref === "worst") {
      matched = [getExtremeStruct(pref)];
    } else {
      matched = primaryStructs.filter((s) => matchesQuality(s, pref));
      if (dedup && matched.length > 1) {
        // If multiple structs match the same resolution (e.g., two 1080p encodes), pick the highest quality one
        matched.sort((a, b) =>
          getVideoQualityScore(b.file_size, b.name, b.url?.web) -
          getVideoQualityScore(a.file_size, a.name, a.url?.web)
        );
        matched = [matched[0]];
      }
    }

    if (matched.length > 0) {
      for (const m of matched) {
        if (!addedSet.has(m)) {
          addedSet.add(m);
          selected.push(m);
        }
      }
      if (dedup) break;
    }
  }

  for (const comp of companions) {
    if (!addedSet.has(comp)) {
      addedSet.add(comp);
      selected.push(comp);
    }
  }

  return selected;
}

/**
 * Filters a list of audio `DownloadStruct`s according to the user's `audioFormat` preferences
 * (e.g. `["flac", "alac", "wav", "aiff", "m4b", "m4a", "aac", "ogg", "opus", "mp3"]`).
 * Recognizes codec tags in both `struct.name` (e.g. `"FLAC"`, `"MP3"`) and archive filenames
 * (e.g. `ost-flac.zip` vs `ost-mp3.zip`), while preserving single untagged soundtrack `.zip`s
 * and multi-album sibling files sharing the winning format (e.g. `Bound (MP3)` + `Rebound (MP3)`).
 */
export function selectAudioStructs(
  structs: DownloadStruct[],
  audioFormats: string[],
  dedup = true,
): DownloadStruct[] {
  const validStructs = structs.filter((s) => Boolean(s.url?.web));
  if (validStructs.length === 0) return [];

  const preferences =
    (audioFormats.length > 0 ? audioFormats : DEFAULT_AUDIO_FORMATS).map(
      normalizeAudioFormat,
    );

  if (!dedup) {
    const isDefaultList = preferences.length === DEFAULT_AUDIO_FORMATS.length &&
      preferences.every((p, i) => p === DEFAULT_AUDIO_FORMATS[i]);
    if (isDefaultList) return validStructs;
  }

  const detectedByStruct = new Map<DownloadStruct, string | undefined>();
  let anyTagged = false;
  let hasExplicitMp3 = false;
  for (const s of validStructs) {
    const det = detectAudioFormat(s.name, s.url?.web);
    detectedByStruct.set(s, det);
    if (det) {
      anyTagged = true;
      if (det === "mp3") hasExplicitMp3 = true;
    }
  }

  // If none of the structs carry codec tags (e.g. a single `ZIP:bastion_ost.zip`), keep all valid structs
  if (!anyTagged) {
    return validStructs;
  }

  const untagged = validStructs.filter((s) => !detectedByStruct.get(s));
  const selected: DownloadStruct[] = [];
  const added = new Set<DownloadStruct>();

  for (const pref of preferences) {
    let matched = validStructs.filter((s) => detectedByStruct.get(s) === pref);
    // On Humble, pairs like `[ost_flac.zip, ost.zip]` leave the standard MP3 archive untagged
    if (
      matched.length === 0 &&
      pref === "mp3" &&
      !hasExplicitMp3 &&
      untagged.length > 0
    ) {
      matched = untagged;
    }
    if (matched.length === 0 && pref === "zip" && untagged.length > 0) {
      matched = untagged;
    }

    if (matched.length > 0) {
      for (const m of matched) {
        if (!added.has(m)) {
          added.add(m);
          selected.push(m);
        }
      }
      if (dedup) break;
    }
  }

  if (selected.length === 0) {
    // Fallback if an item only offers formats outside the requested list (e.g. untagged .zip or only OGG when asking for FLAC)
    return untagged.length > 0 ? untagged : [validStructs[0]];
  }

  return selected;
}

function isComedyVideoDownload(download: BundleDownload): boolean {
  if (download.platform !== Platform.Comedy) return false;
  return download.download_struct.some((s) => {
    if (!s.url?.web) return false;
    const urlClean = s.url.web.split("?")[0];
    if (VIDEO_FILE_EXT_RE.test(urlClean)) return true;
    return Boolean(detectVideoQuality(`${s.name ?? ""} ${urlClean}`));
  });
}

function isComedyAudioDownload(download: BundleDownload): boolean {
  if (download.platform !== Platform.Comedy) return false;
  if (isComedyVideoDownload(download)) return false;
  return download.download_struct.some((s) => {
    if (!s.url?.web) return false;
    return Boolean(detectAudioFormat(s.name, s.url.web));
  });
}

const EBOOK_EXTENSIONS = new Set([
  ".cbz",
  ".cbr",
  ".cb7",
  ".cbt",
  ".cba",
  ".epub",
  ".pdf",
  ".mobi",
  ".prc",
]);

/**
 * Checks whether a DownloadStruct is an actual ebook matching the target format.
 * Prevents non-ebook files (such as `.mp4` videos or `.zip` archives labeled `"Download"`
 * inside `platform: "ebook"` bundles) from being falsely matched as `"pdf"`.
 */
function isMatchingEbookStruct(
  struct: DownloadStruct,
  format: string,
): struct is DownloadStruct & { name: string; url: { web: string } } {
  if (!struct.name || !struct.url) return false;
  if (normalizeFormat(struct.name) !== format) return false;

  // When Humble Bundle labels a download generically as "Download", verify its URL extension
  if (struct.name.trim().toLowerCase() === "download") {
    try {
      const url = new URL(struct.url.web, "https://www.humblebundle.com/");
      const ext = extname(decodeURIComponent(basename(url.pathname)))
        .toLowerCase();
      if (ext && !EBOOK_EXTENSIONS.has(ext)) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Extracts the true file extension from the download URL pathname,
 * preserving compound extensions (e.g. `.hd.pdf`, `.tar.gz`) and distinguishing
 * `PDF (HD)` (`pdf_hd`) from standard `.pdf` so they never collide under `--human-file-names`.
 */
export function resolveUrlExtension(
  rawBaseName: string,
  structName?: string,
): string {
  const lower = rawBaseName.toLowerCase();
  for (const compound of COMPOUND_EXTENSIONS) {
    if (lower.endsWith(compound)) {
      return rawBaseName.slice(-compound.length);
    }
  }

  const ext = extname(rawBaseName);
  if (
    ext.toLowerCase() === ".pdf" &&
    structName &&
    normalizeFormat(structName) === "pdf_hd"
  ) {
    return ".hd.pdf";
  }

  return ext;
}

function deriveSiblingQualifier(
  struct: DownloadStruct,
  rawBaseName: string,
): string {
  const name = (struct.name ?? "").trim();
  if (
    name &&
    !/^(zip|mp4|mkv|avi|mov|mp3|flac|wav|ogg|aac|download|other)$/i.test(name)
  ) {
    return name;
  }
  const stem = stripFileExtension(rawBaseName);
  const compMatch = stem.match(
    /(?:[_.\s-])(subtitles?|supplement|captions?|part\s*0*\d+|disc\s*0*\d+|disk\s*0*\d+|vol(?:ume)?\s*0*\d+|flac|alac|wav|aiff?|m4b|m4a|aac|ogg|opus|mp3|de|fr|es|jp)(?:[_.\s-]\d+)?$/i,
  );
  if (compMatch?.[1]) return compMatch[1];
  return stem;
}

function getTargetExtension(
  struct: DownloadStruct,
  useTorrent: boolean,
): string {
  if (!struct.url) return "";
  const webUrl = new URL(struct.url.web, "https://www.humblebundle.com/");
  const baseExt = resolveUrlExtension(
    decodeURIComponent(basename(webUrl.pathname)),
    struct.name,
  );
  return (useTorrent ? `${baseExt}.torrent` : baseExt).toLowerCase();
}

function getSharedExtSet(
  structs: DownloadStruct[],
  useTorrent: boolean,
): Set<string> {
  if (structs.length <= 1) return new Set();
  const counts = new Map<string, number>();
  for (const s of structs) {
    if (!s.url) continue;
    const ext = getTargetExtension(s, Boolean(useTorrent && s.url.bittorrent));
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  const shared = new Set<string>();
  for (const [ext, count] of counts) {
    if (count > 1) shared.add(ext);
  }
  return shared;
}

/**
 * Constructs a DownloadInfo object for a given bundle subproduct and download structure.
 */
function createDownloadInfo(
  bundle: Bundle,
  subProduct: SubProduct,
  struct: DownloadStruct,
  options: Options,
  date: Date,
  sanitizedBundleName?: string,
  sanitizedProductName?: string,
  downloadKey?: string,
  disambiguateHumanExt = false,
): DownloadInfo {
  if (!struct.url) {
    throw new Error(
      "DownloadStruct.url is undefined, cannot create DownloadInfo.",
    );
  }
  const useTorrent = Boolean(options.torrent && struct.url.bittorrent);
  const rawTargetUrl = useTorrent ? struct.url.bittorrent! : struct.url.web;
  const isAbsoluteUrl = /^https?:\/\//i.test(rawTargetUrl);
  const url = new URL(rawTargetUrl, "https://www.humblebundle.com/");
  const rawBaseName = decodeURIComponent(basename(url.pathname));
  let resolvedExt: string;
  if (useTorrent) {
    const webUrl = new URL(struct.url.web, "https://www.humblebundle.com/");
    resolvedExt = `${
      resolveUrlExtension(
        decodeURIComponent(basename(webUrl.pathname)),
        struct.name,
      )
    }.torrent`;
  } else {
    resolvedExt = resolveUrlExtension(rawBaseName, struct.name);
  }

  let fileName: string;
  let downloadPath: string;
  let filePath: string;

  if (options.outputTemplate) {
    const isoDate = isNaN(date.getTime())
      ? "0000-01-01"
      : date.toISOString().split("T")[0];
    const resolved = resolveOutputTemplate(
      options.downloadFolder,
      options.outputTemplate,
      {
        bundle: bundle.product.human_name,
        publisher: subProduct.payee?.human_name,
        product: subProduct.human_name,
        format: struct.name
          ? normalizeFormat(struct.name)
          : resolvedExt.replace(/^\./, ""),
        ext: resolvedExt,
        year: isoDate.slice(0, 4),
        month: isoDate.slice(5, 7),
        day: isoDate.slice(8, 10),
        date: isoDate,
        gamekey: bundle.gamekey,
        filename: rawBaseName,
      },
    );
    fileName = resolved.fileName;
    downloadPath = resolved.downloadPath;
    filePath = resolved.filePath;
  } else {
    if (options.humanFileNames) {
      const suffix = disambiguateHumanExt
        ? ` (${deriveSiblingQualifier(struct, rawBaseName)})`
        : "";
      fileName = sanitizeFilename(
        `${subProduct.human_name}${suffix}${resolvedExt}`,
      );
    } else {
      fileName = sanitizeFilename(rawBaseName);
    }
    const bundleDir = options.bundleFolders
      ? (sanitizedBundleName ?? sanitizeFilename(bundle.product.human_name))
      : "";
    const productDir = options.productFolders
      ? (sanitizedProductName ?? sanitizeFilename(subProduct.human_name))
      : "";
    downloadPath = resolve(options.downloadFolder, bundleDir, productDir);
    filePath = resolve(downloadPath, fileName);
  }

  return {
    bundle: bundle.product.human_name,
    gameKey: bundle.gamekey,
    name: subProduct.human_name,
    publisher: subProduct.payee?.human_name,
    icon: subProduct.icon,
    productUrl: subProduct.url,
    machineName: subProduct.machine_name,
    entitlementId: subProduct.entitlement_id,
    downloadKey,
    fileName,
    downloadPath,
    filePath,
    url,
    ...(!isAbsoluteUrl ? { webFilename: rawTargetUrl } : {}),
    sha1: struct.sha1,
    md5: struct.md5,
    structName: struct.name ?? fileName,
    date,
    file_size: struct.file_size,
  };
}

/**
 * Filters all downloadable items from bundles matching the chosen platforms and formats.
 * Applies deduplication (by filename or hashes) when enabled.
 *
 * @param bundles Array of Humble Bundles
 * @param options Runtime options (platforms, formats, folders, dedup)
 * @param totals Statistics tracker
 * @param progress MultiBarWrapper progress logger
 * @returns Sorted array of DownloadInfo items
 */
export function filterBundles(
  bundles: Bundle[],
  options: Options,
  totals: Totals,
  progress: MultiBarWrapper,
): DownloadInfo[] {
  progress.log(
    `${
      yellow(
        bundles.length.toString(),
      )
    } bundles containing downloadable items`,
  );
  const downloads: DownloadInfo[] = [];
  const byFilePath = new Map<string, DownloadInfo>();
  const byFileName = new Map<string, DownloadInfo>();
  const byHash = new Map<string, DownloadInfo>();

  const formats = expandFormatPreferences(options.format ?? []);
  const platforms = options.platform ?? [];
  const filters = compileItemFilters(options);

  for (const bundle of bundles) {
    if (!filters.matchesBundleKey(bundle.gamekey ?? "")) continue;
    const bundleDate = new Date(bundle.created);
    const sanitizedBundleName = options.bundleFolders
      ? sanitizeFilename(bundle.product.human_name)
      : "";
    for (const subProduct of bundle.subproducts) {
      if (
        !filters.matchesText(
          bundle.product.human_name,
          subProduct.human_name,
          subProduct.machine_name,
        )
      ) {
        continue;
      }
      const sanitizedProductName = options.productFolders
        ? sanitizeFilename(subProduct.human_name)
        : "";
      const activeDownloads = subProduct.downloads.filter((d) =>
        platforms.includes(d.platform)
      );

      for (const download of activeDownloads) {
        let structsToAdd: DownloadStruct[] = [];

        if (download.platform === Platform.Ebook) {
          if (options.dedup) {
            for (const format of formats) {
              const matchingStructs = download.download_struct.filter((s) =>
                isMatchingEbookStruct(s, format)
              );
              if (matchingStructs.length > 0) {
                structsToAdd = matchingStructs;
                break;
              }
            }
          } else {
            for (const format of formats) {
              const matchingStructs = download.download_struct.filter((s) =>
                isMatchingEbookStruct(s, format)
              );
              structsToAdd.push(...matchingStructs);
            }
          }
          // In `all` mode, if an item in `platform: "ebook"` had no ebook format match
          // (e.g., bonus .zip or .mp4 video attached to an ebook bundle), include it only if non-ebook platforms are also selected
          if (
            structsToAdd.length === 0 &&
            platforms.some((p) => p !== Platform.Ebook)
          ) {
            structsToAdd = download.download_struct.filter((s) => s.url?.web);
          }
        } else if (
          download.platform === Platform.Video ||
          isComedyVideoDownload(download)
        ) {
          structsToAdd = selectVideoStructs(
            download.download_struct,
            options.videoQuality ?? ["best"],
            options.dedup,
          );
        } else if (
          download.platform === Platform.Audio ||
          (download.platform === Platform.Comedy &&
            isComedyAudioDownload(download))
        ) {
          structsToAdd = selectAudioStructs(
            download.download_struct,
            options.audioFormat ?? DEFAULT_AUDIO_FORMATS,
            options.dedup,
          );
        } else {
          // Non-ebook/non-video/non-audio platforms (games, etc.) are added directly
          structsToAdd = download.download_struct.filter((s) => s.url?.web);
        }

        const sharedExts = options.humanFileNames
          ? getSharedExtSet(structsToAdd, Boolean(options.torrent))
          : undefined;

        for (const struct of structsToAdd) {
          if (!filters.matchesSize(struct.file_size)) continue;
          const parsedUpload = struct.uploaded_at
            ? new Date(struct.uploaded_at)
            : bundleDate;
          const itemDate = isNaN(parsedUpload.getTime())
            ? bundleDate
            : parsedUpload;
          if (!filters.matchesDate(itemDate)) continue;

          let disambiguate = false;
          if (sharedExts && sharedExts.size > 0 && struct.url) {
            const useTorrent = Boolean(
              options.torrent && struct.url.bittorrent,
            );
            disambiguate = sharedExts.has(
              getTargetExtension(struct, useTorrent),
            );
          }

          totals.preFilteredDownloads++;
          const downloadInfo = createDownloadInfo(
            bundle,
            subProduct,
            struct,
            options,
            itemDate,
            sanitizedBundleName,
            sanitizedProductName,
            download.machine_name,
            disambiguate,
          );

          // Check for duplicates using Maps
          let duplicateSource: DownloadInfo | undefined;
          if (options.dedup) {
            duplicateSource = byFileName.get(
              downloadInfo.fileName.toLowerCase(),
            );
            if (!duplicateSource && struct.sha1 && struct.md5) {
              const key =
                `${struct.sha1.toLowerCase()}|${struct.md5.toLowerCase()}`;
              duplicateSource = byHash.get(key);
            }
          }

          if (!duplicateSource) {
            const existingPath = byFilePath.get(
              downloadInfo.filePath.toLowerCase(),
            );
            if (!existingPath) {
              downloads.push(downloadInfo);
              byFilePath.set(
                downloadInfo.filePath.toLowerCase(),
                downloadInfo,
              );
              byFileName.set(
                downloadInfo.fileName.toLowerCase(),
                downloadInfo,
              );
              if (downloadInfo.sha1 && downloadInfo.md5) {
                byHash.set(
                  `${downloadInfo.sha1.toLowerCase()}|${downloadInfo.md5.toLowerCase()}`,
                  downloadInfo,
                );
              }
            } else {
              progressDebug(
                progress,
                `Potential duplicate purchase ${downloadInfo.fileName}, ${bundle.product.human_name}, ${existingPath.bundle}, ${existingPath.fileName}`,
              );
            }
          } else {
            progressDebug(
              progress,
              `Potential duplicate purchase ${downloadInfo.fileName}, ${bundle.product.human_name}, ${duplicateSource.bundle}, ${duplicateSource.fileName}`,
            );
          }
        }
      }
    }
  }

  totals.filteredDownloads = downloads.length;
  return sortDownloads(downloads);
}

/**
 * Filters and prioritizes ebooks specifically (e.g. cbz -> epub -> pdf_hd -> pdf -> mobi).
 * Keeps the latest or highest-priority format per product.
 *
 * @param bundles Array of Humble Bundles
 * @param options Runtime options (formats, folders, dedup)
 * @param totals Statistics tracker
 * @param progress MultiBarWrapper progress logger
 * @returns Sorted array of DownloadInfo items
 */
export function filterEbooks(
  bundles: Bundle[],
  options: Options,
  totals: Totals,
  progress: MultiBarWrapper,
): DownloadInfo[] {
  const formats = expandFormatPreferences(options.format ?? []);
  const formatRank = new Map<string, number>();
  formats.forEach((f, idx) => formatRank.set(f, idx));

  const getStructRank = (s: DownloadStruct): number => {
    for (const fmt of formats) {
      if (isMatchingEbookStruct(s, fmt)) {
        return formatRank.get(fmt) ?? Infinity;
      }
    }
    return Infinity;
  };

  return filterMediaByPriority(bundles, options, totals, progress, {
    mediaLabel: "ebooks",
    isMatchingDownload: (d) => d.platform === Platform.Ebook,
    selectStructs: (structs, dedup) => {
      const matched: { struct: DownloadStruct; rank: number }[] = [];
      for (const s of structs) {
        const rank = getStructRank(s);
        if (rank !== Infinity) matched.push({ struct: s, rank });
      }
      if (matched.length === 0) return [];
      matched.sort((a, b) => a.rank - b.rank);
      return dedup ? [matched[0].struct] : matched.map((m) => m.struct);
    },
    rankAndScore: (selectedStructs) => ({
      rank: getStructRank(selectedStructs[0]),
      score: 0,
    }),
  });
}

interface SubproductGroupEntry {
  rank: number;
  score: number;
  date: Date;
  items: DownloadInfo[];
}

function buildSelectedDownloadInfos(
  bundle: Bundle,
  subProduct: SubProduct,
  download: BundleDownload,
  selectedStructs: DownloadStruct[],
  bundleDate: Date,
  options: Options,
  filters: ReturnType<typeof compileItemFilters>,
  sanitizedBundleName: string,
  sanitizedProductName: string,
  totals: Totals,
): { items: DownloadInfo[]; maxDate: Date } {
  const sharedExts = options.humanFileNames
    ? getSharedExtSet(selectedStructs, Boolean(options.torrent))
    : undefined;
  const items: DownloadInfo[] = [];
  let maxDate = bundleDate;

  for (const struct of selectedStructs) {
    if (!struct.url?.web) continue;
    if (!filters.matchesSize(struct.file_size)) continue;
    const parsedUpload = struct.uploaded_at
      ? new Date(struct.uploaded_at)
      : bundleDate;
    const uploadedAt = isNaN(parsedUpload.getTime())
      ? bundleDate
      : parsedUpload;
    const itemDate = uploadedAt > bundleDate ? uploadedAt : bundleDate;
    if (!filters.matchesDate(itemDate)) continue;
    if (itemDate > maxDate) maxDate = itemDate;

    let disambiguate = false;
    if (sharedExts && sharedExts.size > 0) {
      const useTorrent = Boolean(options.torrent && struct.url.bittorrent);
      disambiguate = sharedExts.has(getTargetExtension(struct, useTorrent));
    }

    totals.preFilteredDownloads++;
    items.push(
      createDownloadInfo(
        bundle,
        subProduct,
        struct,
        options,
        itemDate,
        sanitizedBundleName,
        sanitizedProductName,
        download.machine_name,
        disambiguate,
      ),
    );
  }

  return { items, maxDate };
}

interface MediaFilterConfig {
  mediaLabel: string;
  isMatchingDownload: (download: BundleDownload) => boolean;
  selectStructs: (
    structs: DownloadStruct[],
    dedup?: boolean,
  ) => DownloadStruct[];
  rankAndScore: (selectedStructs: DownloadStruct[]) => {
    rank: number;
    score: number;
  };
}

/**
 * Shared implementation for filtering and deduplicating audio/video downloads
 * across bundles by preference rank, upload/purchase date, and quality score.
 */
function filterMediaByPriority(
  bundles: Bundle[],
  options: Options,
  totals: Totals,
  progress: MultiBarWrapper,
  config: MediaFilterConfig,
): DownloadInfo[] {
  const activeDownloads = new Set<DownloadInfo>();
  const byMachineName = new Map<string, SubproductGroupEntry>();
  const byFilePath = new Map<string, DownloadInfo>();
  const filters = compileItemFilters(options);
  let matchingBundleCount = 0;

  for (const bundle of bundles) {
    let bundleHasMatch = false;
    const bundleMatchesKey = filters.matchesBundleKey(bundle.gamekey ?? "");
    const bundleDate = new Date(bundle.created);
    const sanitizedBundleName = options.bundleFolders
      ? sanitizeFilename(bundle.product.human_name)
      : "";

    for (const subProduct of bundle.subproducts) {
      const matchingDownloads = subProduct.downloads.filter(
        config.isMatchingDownload,
      );
      if (matchingDownloads.length === 0) continue;
      if (!bundleHasMatch) {
        bundleHasMatch = true;
        matchingBundleCount++;
      }
      if (!bundleMatchesKey) continue;
      if (
        !filters.matchesText(
          bundle.product.human_name,
          subProduct.human_name,
          subProduct.machine_name,
        )
      ) {
        continue;
      }
      const sanitizedProductName = options.productFolders
        ? sanitizeFilename(subProduct.human_name)
        : "";

      for (const download of matchingDownloads) {
        const selectedStructs = config.selectStructs(
          download.download_struct,
          options.dedup,
        );
        if (selectedStructs.length === 0) continue;

        const { items, maxDate } = buildSelectedDownloadInfos(
          bundle,
          subProduct,
          download,
          selectedStructs,
          bundleDate,
          options,
          filters,
          sanitizedBundleName,
          sanitizedProductName,
          totals,
        );
        if (items.length === 0) continue;

        const { rank, score } = config.rankAndScore(selectedStructs);
        const machineKey = subProduct.machine_name.toLowerCase();
        const existing = options.dedup
          ? byMachineName.get(machineKey)
          : undefined;
        const shouldUse = !existing ||
          rank < existing.rank ||
          (rank === existing.rank && maxDate > existing.date) ||
          (rank === existing.rank &&
            maxDate.getTime() === existing.date.getTime() &&
            score > existing.score);

        if (!shouldUse) continue;

        if (existing) {
          for (const oldItem of existing.items) {
            activeDownloads.delete(oldItem);
            byFilePath.delete(oldItem.filePath.toLowerCase());
          }
          byMachineName.delete(machineKey);
        }

        const keptItems: DownloadInfo[] = [];
        for (const item of items) {
          const pathKey = item.filePath.toLowerCase();
          if (!byFilePath.has(pathKey)) {
            activeDownloads.add(item);
            byFilePath.set(pathKey, item);
            keptItems.push(item);
          } else {
            const duplicate = byFilePath.get(pathKey);
            progressDebug(
              progress,
              `Potential duplicate purchase ${item.fileName}, ${bundle.product.human_name}, ${duplicate?.bundle}, ${duplicate?.fileName}`,
            );
          }
        }

        if (options.dedup && keptItems.length > 0) {
          byMachineName.set(machineKey, {
            rank,
            score,
            date: maxDate,
            items: keptItems,
          });
        }
      }
    }
  }

  progress.log(
    `${
      yellow(matchingBundleCount.toString())
    } bundles containing ${config.mediaLabel}`,
  );
  const downloads = Array.from(activeDownloads);
  totals.filteredDownloads = downloads.length;
  return sortDownloads(downloads);
}

/**
 * Filters and prioritizes soundtracks, audiobooks, and comedy audio albums
 * according to `options.audioFormat` (defaulting to lossless `flac` -> `alac` -> `wav` -> ... -> `mp3`).
 */
export function filterAudio(
  bundles: Bundle[],
  options: Options,
  totals: Totals,
  progress: MultiBarWrapper,
): DownloadInfo[] {
  const audioPrefs =
    (options.audioFormat && options.audioFormat.length > 0
      ? options.audioFormat
      : DEFAULT_AUDIO_FORMATS).map(normalizeAudioFormat);

  return filterMediaByPriority(bundles, options, totals, progress, {
    mediaLabel: "audio",
    isMatchingDownload: (d) =>
      d.platform === Platform.Audio || isComedyAudioDownload(d),
    selectStructs: (structs, dedup) =>
      selectAudioStructs(structs, audioPrefs, dedup),
    rankAndScore: (selectedStructs) => {
      let rank = Infinity;
      for (const s of selectedStructs) {
        const det = detectAudioFormat(s.name, s.url?.web);
        const idx = det ? audioPrefs.indexOf(det) : -1;
        if (idx !== -1 && idx < rank) rank = idx;
      }
      return { rank, score: 0 };
    },
  });
}

/**
 * Filters and prioritizes videos (including video courses and stand-up comedy specials)
 * according to `options.videoQuality` (e.g. `["best"]` or `["1080p", "best"]`).
 */
export function filterVideos(
  bundles: Bundle[],
  options: Options,
  totals: Totals,
  progress: MultiBarWrapper,
): DownloadInfo[] {
  const videoPrefs =
    (options.videoQuality && options.videoQuality.length > 0
      ? options.videoQuality
      : ["best"]).map(normalizeVideoQuality);

  return filterMediaByPriority(bundles, options, totals, progress, {
    mediaLabel: "videos",
    isMatchingDownload: (d) =>
      d.platform === Platform.Video || isComedyVideoDownload(d),
    selectStructs: (structs, dedup) =>
      selectVideoStructs(structs, videoPrefs, dedup),
    rankAndScore: (selectedStructs) => {
      const primarySelected = selectedStructs.find(
        (s) => !isVideoCompanionStruct(s),
      ) ?? selectedStructs[0];
      const detectedQ = detectVideoQuality(
        `${primarySelected.name ?? ""} ${primarySelected.url?.web ?? ""}`,
      );
      let rank = Infinity;
      for (let i = 0; i < videoPrefs.length; i++) {
        const pref = videoPrefs[i];
        if (
          pref === "best" ||
          pref === "worst" ||
          detectedQ === pref ||
          (pref === "hd" && (detectedQ === "1080p" || detectedQ === "720p")) ||
          (pref === "sd" && (detectedQ === "480p" || detectedQ === "360p"))
        ) {
          rank = i;
          break;
        }
      }
      const rawScore = getVideoQualityScore(
        primarySelected.file_size,
        primarySelected.name,
        primarySelected.url?.web,
      );
      const score = videoPrefs[rank] === "worst" ? -rawScore : rawScore;
      return { rank, score };
    },
  });
}
