import { RetryOptions } from "@std/async/retry";
import { ParseOptions } from "@std/cli/parse-args";
import packageInfo from "../deno.json" with { type: "json" };
import { Platform } from "../types/bundle.ts";

export const DEFAULT_FORMATS = ["cb?", "epub", "pdf_hd", "pdf", "mobi"];
export const SUPPORTED_FORMATS = [
  "cb?",
  "cbz",
  "cbr",
  "cb7",
  "cbt",
  "cba",
  "epub",
  "pdf_hd",
  "pdf",
  "mobi",
];
export const DEFAULT_AUDIO_FORMATS = [
  "flac",
  "alac",
  "wav",
  "aiff",
  "m4b",
  "m4a",
  "aac",
  "ogg",
  "opus",
  "mp3",
];
export const SUPPORTED_AUDIO_FORMATS = [
  ...DEFAULT_AUDIO_FORMATS,
  "rex",
  "zip",
];
export const SUPPORTED_VIDEO_QUALITIES = [
  "best",
  "worst",
  "4k",
  "2160p",
  "1440p",
  "1080p",
  "720p",
  "480p",
  "360p",
  "hd",
  "sd",
];
export const optionsFileName = "options.json";
export const cacheFileName = "checksums.json";
export const logFileName = "humblebundle.log";

export const version = packageInfo.version;
export const userAgent = `HumbleBundle-Ebook-Downloader/${version}`;

/**
 * Valid CLI command identifiers.
 */
export const COMMANDS = {
  all: "all",
  audio: "audio",
  bundles: "bundles",
  checksums: "checksums",
  cleanup: "cleanup",
  cleanupAudio: "cleanupaudio",
  cleanupEbooks: "cleanupebooks",
  cleanupTrove: "cleanuptrove",
  cleanupVideos: "cleanupvideos",
  completions: "completions",
  ebooks: "ebooks",
  export: "export",
  list: "list",
  repair: "repair",
  stats: "stats",
  trove: "trove",
  unclaimed: "unclaimed",
  verify: "verify",
  videos: "videos",
} as const;

export const COMMAND_DESCRIPTIONS: Record<string, string> = {
  ebooks: "Download ebooks with format prioritization (Default)",
  audio: "Download soundtracks and audiobooks with audio format prioritization",
  videos: "Download videos and comedy specials with quality prioritization",
  all: "Download all items matching selected platforms",
  trove: "Download Humble Trove catalog items",
  verify: "Re-hash local files from disk to verify integrity against Humble Bundle",
  repair: "Verify local files and automatically re-download missing/corrupted files",
  bundles: "List purchased bundles with date, gamekey, completion status, and size",
  unclaimed: "List unclaimed Humble Choice picks, unredeemed keys, and external links",
  stats: "Display library breakdown, format statistics, and top publishers",
  list: "Alias for stats",
  export: "Export searchable catalog.json and catalog.csv of your library",
  checksums: "Calculate and cache checksums of all existing files in download folder",
  cleanup: "Organize files and delete items no longer part of your bundles",
  cleanupaudio: "Clean up audio downloads specifically",
  cleanupebooks: "Clean up ebook downloads specifically",
  cleanuptrove: "Clean up Trove downloads",
  cleanupvideos: "Clean up video downloads specifically",
  completions: "Generate shell tab-completions (bash, zsh, fish)",
};

export const argBooleans = [
  "dedup",
  "bundleFolders",
  "productFolders",
  "humanFileNames",
  "update",
  "dryRun",
  "opf",
  "covers",
  "torrent",
  "extract",
  "playlists",
  "preserveMtime",
  "linkDuplicates",
  "deep",
  "json",
  "verbose",
];

export const argDefaults = {
  dedup: true,
  bundleFolders: true,
  productFolders: true,
  humanFileNames: false,
  update: false,
  dryRun: false,
  opf: false,
  covers: false,
  torrent: false,
  extract: false,
  playlists: false,
  preserveMtime: false,
  linkDuplicates: false,
  deep: false,
  json: false,
  verbose: false,
  parallel: 5,
  format: DEFAULT_FORMATS,
  audioFormat: DEFAULT_AUDIO_FORMATS,
  platform: Object.values(Platform),
  videoQuality: ["best"],
  bundleKey: [] as string[],
};

const argStrings = [
  "downloadFolder",
  "authToken",
  "bundleKey",
  "filter",
  "exclude",
  "since",
  "before",
  "maxSize",
  "minSize",
  "rateLimit",
  "outputTemplate",
  "webhook",
  "logFile",
];

export const argAlias: Record<string, string | string[]> = {
  downloadFolder: ["d", "download-folder"],
  parallel: "l",
  authToken: ["t", "auth-token"],
  format: "f",
  audioFormat: ["a", "audio-format"],
  platform: "p",
  videoQuality: ["q", "video-quality"],
  bundleKey: ["k", "bundle-key"],
  filter: "s",
  exclude: "x",
  since: "since",
  before: "before",
  maxSize: ["m", "max-size"],
  minSize: "min-size",
  rateLimit: ["r", "rate-limit"],
  outputTemplate: "output-template",
  preserveMtime: "preserve-mtime",
  linkDuplicates: "link-duplicates",
  deep: "deep",
  webhook: "webhook",
  bundleFolders: ["b", "bundle-folders"],
  productFolders: "product-folders",
  humanFileNames: "human-file-names",
  update: "u",
  dryRun: ["n", "dry-run"],
  json: "j",
  verbose: "v",
  logFile: "log-file",
};

const argCollect = [
  "format",
  "audioFormat",
  "platform",
  "videoQuality",
  "bundleKey",
];

export const argDescriptions: Record<string, string> = {
  dedup: "Dedup the downloads",
  bundleFolders: "Arrange downloads in bundle folders",
  productFolders: "Individual product folders",
  humanFileNames: "Use human readable file names",
  update: "Force fetch bundle details instead of using local cache",
  dryRun: "Preview downloads and cleanups without modifying files on disk",
  opf: "Generate Calibre/Komga/Kavita .opf metadata sidecar files alongside downloads",
  covers: "Download cover art images (.jpg/.png) alongside items",
  torrent: "Download .torrent files instead of direct web downloads when available",
  extract: "Automatically extract .zip and .tar.gz archives into a subfolder after download",
  playlists: "Generate .m3u8 playlists for audio downloads in each folder",
  preserveMtime: "Set downloaded file modification timestamps to their Humble Bundle publication/upload date",
  linkDuplicates: "Hardlink (or copy) already-downloaded identical files instead of re-downloading when --no-dedup is used",
  deep: "Perform deep structural archive/ebook validation (PDF/ZIP/EPUB/CBZ/CBR headers & trailers) during verify/repair",
  webhook: "POST run summary JSON to this URL when a sync/repair run completes",
  rateLimit: "Maximum total download bandwidth speed across workers (e.g. 5MB, 500KB)",
  outputTemplate: "Custom path template using {bundle}, {publisher}, {product}, {format}, {ext}, {year}, {filename}",
  json: "Output machine-readable JSON to stdout (for stats, list, bundles, unclaimed, verify)",
  verbose: "Show detailed debug and diagnostic logs in the terminal",
  logFile: "Custom file path for detailed logs (defaults to <downloadFolder>/humblebundle.log)",
  bundleKey: "Target specific bundle gamekey(s) or Humble download URL(s) (repeatable)",
  filter: "Case-insensitive substring or regex to filter bundle or item names",
  exclude: "Case-insensitive substring or regex to exclude bundle or item names",
  since: "Only include bundles/items created or updated on or after this date (e.g. 2025-01-01)",
  before: "Only include bundles/items created or updated on or before this date (e.g. 2025-12-31)",
  maxSize: "Maximum file size to download (e.g. 500MB, 2GB)",
  minSize: "Minimum file size to download (e.g. 1MB, 50KB)",
  downloadFolder: "Download folder",
  parallel: "Parallel limit",
  authToken: "Authentication cookie from your browser (_simpleauth_sess)",
  format:
    'Format(s) to download (e.g. "cb?" for any comic archive cbz/cbr, or explicit cbz, cbr, epub, pdf_hd, pdf, mobi). Can be specified multiple times in priority order, e.g. "-f \'cb?\' -f pdf", unless --no-dedup is specified.',
  audioFormat:
    'Audio format(s) to download (flac, alac, wav, aiff, m4b, m4a, aac, ogg, opus, mp3). Can be specified multiple times in priority order, e.g. "-a flac -a mp3", unless --no-dedup is specified.',
  platform:
    'Platform(s) to download. Can be specified multiple times. Will prioritise in the order given, i.e. if you say "-p linux -p win" will download linux format or win if linux does not exist, unless --no-dedup is specified.',
  videoQuality:
    'Video quality preference(s) (best, worst, 4k/2160p, 1440p, 1080p, 720p, 480p, 360p, hd, sd). Can be specified multiple times in priority order, e.g. "-q 1080p -q best" picks 1080p when available, otherwise the highest quality.',
};

export const argRequired = ["downloadFolder"];
export const argNoSave = [
  "downloadFolder",
  "authToken",
  "update",
  "dryRun",
  "bundleKey",
  "filter",
  "exclude",
  "since",
  "before",
  "maxSize",
  "minSize",
  "rateLimit",
  "preserveMtime",
  "linkDuplicates",
  "deep",
  "webhook",
  "opf",
  "covers",
  "torrent",
  "extract",
  "playlists",
  "json",
  "verbose",
  "logFile",
];

export const parseOptions: ParseOptions = {
  boolean: argBooleans,
  negatable: argBooleans,
  default: argDefaults,
  string: argStrings,
  alias: argAlias,
  collect: argCollect,
};

export const INVALID_COMMAND_ERROR = "No or invalid command!";
export const MISSING_DOWNLOAD_FOLDER_ERROR =
  "Please specify download folder (--download-folder or -d)";
export const MISSING_AUTH_TOKEN_ERROR =
  "Please specify auth token (--auth-token or -t)";

export const retryOptions: RetryOptions = {
  maxAttempts: 3,
  minTimeout: 10,
  multiplier: 2,
  jitter: 0,
};
