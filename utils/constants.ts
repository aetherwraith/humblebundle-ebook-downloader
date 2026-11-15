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
  cleanupTrash: "cleanuptrash",
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
  verify:
    "Re-hash local files from disk to verify integrity against Humble Bundle",
  repair:
    "Verify local files and automatically re-download missing/corrupted files",
  bundles:
    "List purchased bundles with date, gamekey, completion status, and size",
  unclaimed:
    "List unclaimed Humble Choice picks, unredeemed keys, and external links",
  stats: "Display library breakdown, format statistics, and top publishers",
  list: "Alias for stats",
  export: "Export searchable catalog.json and catalog.csv of your library",
  checksums:
    "Calculate and cache checksums of all existing files in download folder",
  cleanup: "Organize files and delete items no longer part of your bundles",
  cleanupaudio: "Clean up audio downloads specifically",
  cleanupebooks: "Clean up ebook downloads specifically",
  cleanuptrash: "Prune or empty files in <downloadFolder>/.trash/",
  cleanuptrove: "Clean up Trove downloads",
  cleanupvideos: "Clean up video downloads specifically",
  completions: "Generate shell tab-completions (bash, zsh, fish)",
};

export type OptionType = "boolean" | "string" | "number" | "string[]";

export interface OptionSchemaEntry {
  type: OptionType;
  default?: unknown;
  alias?: string | string[];
  description: string;
  required?: boolean;
  noSave?: boolean;
  env?: string;
}

/**
 * Single source of truth for all CLI options, defaults, aliases, env vars, and descriptions.
 */
export const OPTION_SCHEMA: Record<string, OptionSchemaEntry> = {
  dedup: {
    type: "boolean",
    default: true,
    description: "Dedup the downloads",
  },
  bundleFolders: {
    type: "boolean",
    default: true,
    alias: ["b", "bundle-folders"],
    description: "Arrange downloads in bundle folders",
  },
  productFolders: {
    type: "boolean",
    default: true,
    alias: "product-folders",
    description: "Individual product folders",
  },
  humanFileNames: {
    type: "boolean",
    default: false,
    alias: "human-file-names",
    description: "Use human readable file names",
  },
  update: {
    type: "boolean",
    default: false,
    alias: "u",
    noSave: true,
    description:
      "Fetch newly added bundle details from the API (incremental update)",
  },
  forceUpdate: {
    type: "boolean",
    default: false,
    alias: "force-update",
    noSave: true,
    description:
      "Discard local bundles.json cache and re-fetch all bundle details from the API",
  },
  dryRun: {
    type: "boolean",
    default: false,
    alias: ["n", "dry-run"],
    noSave: true,
    description:
      "Preview downloads and cleanups without modifying files on disk",
  },
  yes: {
    type: "boolean",
    default: false,
    alias: "y",
    noSave: true,
    description:
      "Non-interactive mode: accept CLI flag overrides over saved options.json without prompting",
  },
  showConfig: {
    type: "boolean",
    default: false,
    alias: "show-config",
    noSave: true,
    description:
      "Print the effective merged configuration (with authToken redacted) and exit",
  },
  diff: {
    type: "boolean",
    default: false,
    alias: "diff",
    noSave: true,
    description:
      "Show a summary of new bundles, migrated orders, changed hashes, and files to be removed",
  },
  backupReplaced: {
    type: "boolean",
    default: false,
    alias: "backup-replaced",
    noSave: true,
    description:
      "Move files removed during cleanup into <downloadFolder>/.trash/ instead of deleting them",
  },
  trashMaxAge: {
    type: "number",
    alias: "trash-max-age",
    noSave: true,
    description:
      "Maximum age in days for files in <downloadFolder>/.trash/ when running cleanuptrash",
  },
  prune: {
    type: "boolean",
    default: false,
    noSave: true,
    description:
      "Remove stale checksums.json entries whose files no longer exist on disk (during checksums)",
  },
  opf: {
    type: "boolean",
    default: false,
    noSave: true,
    description:
      "Generate Calibre/Komga/Kavita .opf metadata sidecar files alongside downloads",
  },
  nfo: {
    type: "boolean",
    default: false,
    noSave: true,
    description:
      "Generate Kodi/Jellyfin/Plex .nfo metadata sidecar files alongside audio and video downloads",
  },
  covers: {
    type: "boolean",
    default: false,
    noSave: true,
    description: "Download cover art images (.jpg/.png) alongside items",
  },
  externalLinks: {
    type: "boolean",
    default: false,
    alias: "external-links",
    noSave: true,
    description:
      "Write .url / .desktop bookmark sidecars for external-link-only items",
  },
  torrent: {
    type: "boolean",
    default: false,
    noSave: true,
    description:
      "Download .torrent files instead of direct web downloads when available",
  },
  extract: {
    type: "boolean",
    default: false,
    noSave: true,
    description:
      "Automatically extract .zip and .tar.gz archives into a subfolder after download",
  },
  extractClean: {
    type: "boolean",
    default: false,
    alias: "extract-clean",
    noSave: true,
    description:
      "Delete archive files after successful extraction (implies --extract)",
  },
  playlists: {
    type: "boolean",
    default: false,
    noSave: true,
    description: "Generate .m3u8 playlists for audio downloads in each folder",
  },
  preserveMtime: {
    type: "boolean",
    default: false,
    alias: "preserve-mtime",
    noSave: true,
    description:
      "Set downloaded file modification timestamps to their Humble Bundle publication/upload date",
  },
  linkDuplicates: {
    type: "boolean",
    default: false,
    alias: "link-duplicates",
    noSave: true,
    description:
      "Hardlink (or copy) already-downloaded identical files instead of re-downloading when --no-dedup is used",
  },
  deep: {
    type: "boolean",
    default: false,
    alias: "deep",
    noSave: true,
    description:
      "Perform deep structural archive/ebook validation (PDF/ZIP/EPUB/CBZ/CBR headers & trailers) during verify/repair",
  },
  strictChecksums: {
    type: "boolean",
    default: false,
    alias: "strict-checksums",
    noSave: true,
    description:
      "Fail and quarantine downloads whose SHA-1/MD5 does not match Humble Bundle API metadata",
  },
  webhook: {
    type: "string",
    alias: "webhook",
    noSave: true,
    description:
      "POST run summary JSON to this URL when a sync/repair run completes",
  },
  rateLimit: {
    type: "string",
    alias: ["r", "rate-limit"],
    noSave: true,
    description:
      "Maximum total download bandwidth speed across workers (e.g. 5MB, 500KB)",
  },
  outputTemplate: {
    type: "string",
    alias: "output-template",
    description:
      "Custom path template using {bundle}, {publisher}, {product}, {format}, {ext}, {year}, {month}, {day}, {date}, {gamekey}, {filename}",
  },
  json: {
    type: "boolean",
    default: false,
    alias: "j",
    noSave: true,
    description:
      "Output machine-readable JSON to stdout (for stats, list, bundles, unclaimed, verify)",
  },
  verbose: {
    type: "boolean",
    default: false,
    alias: "v",
    noSave: true,
    description: "Show detailed debug and diagnostic logs in the terminal",
  },
  logFile: {
    type: "string",
    alias: "log-file",
    noSave: true,
    description:
      "Custom file path for detailed logs (defaults to <downloadFolder>/humblebundle.log)",
  },
  bundleKey: {
    type: "string[]",
    default: [] as string[],
    alias: ["k", "bundle-key"],
    noSave: true,
    description:
      "Target specific bundle gamekey(s) or Humble download URL(s) (repeatable)",
  },
  filter: {
    type: "string",
    alias: "s",
    noSave: true,
    description:
      "Case-insensitive substring or regex to filter bundle or item names",
  },
  exclude: {
    type: "string",
    alias: "x",
    noSave: true,
    description:
      "Case-insensitive substring or regex to exclude bundle or item names",
  },
  since: {
    type: "string",
    alias: "since",
    noSave: true,
    description:
      "Only include bundles/items created or updated on or after this date (e.g. 2025-01-01)",
  },
  before: {
    type: "string",
    alias: "before",
    noSave: true,
    description:
      "Only include bundles/items created or updated on or before this date (e.g. 2025-12-31)",
  },
  maxSize: {
    type: "string",
    alias: ["m", "max-size"],
    noSave: true,
    description: "Maximum file size to download (e.g. 500MB, 2GB)",
  },
  minSize: {
    type: "string",
    alias: "min-size",
    noSave: true,
    description: "Minimum file size to download (e.g. 1MB, 50KB)",
  },
  downloadFolder: {
    type: "string",
    alias: ["d", "download-folder"],
    required: true,
    noSave: true,
    description: "Download folder",
  },
  parallel: {
    type: "number",
    default: 5,
    alias: "l",
    description: "Parallel limit",
  },
  authToken: {
    type: "string",
    alias: ["t", "auth-token"],
    noSave: true,
    description: "Authentication cookie from your browser (_simpleauth_sess)",
  },
  format: {
    type: "string[]",
    default: DEFAULT_FORMATS,
    alias: "f",
    description:
      'Format(s) to download (e.g. "cb?" for any comic archive cbz/cbr, or explicit cbz, cbr, epub, pdf_hd, pdf, mobi). Can be specified multiple times in priority order, e.g. "-f \'cb?\' -f pdf", unless --no-dedup is specified.',
  },
  audioFormat: {
    type: "string[]",
    default: DEFAULT_AUDIO_FORMATS,
    alias: ["a", "audio-format"],
    description:
      'Audio format(s) to download (flac, alac, wav, aiff, m4b, m4a, aac, ogg, opus, mp3). Can be specified multiple times in priority order, e.g. "-a flac -a mp3", unless --no-dedup is specified.',
  },
  platform: {
    type: "string[]",
    default: Object.values(Platform),
    alias: "p",
    description:
      'Platform(s) to download. Can be specified multiple times. Will prioritise in the order given, i.e. if you say "-p linux -p win" will download linux format or win if linux does not exist, unless --no-dedup is specified.',
  },
  videoQuality: {
    type: "string[]",
    default: ["best"],
    alias: ["q", "video-quality"],
    description:
      'Video quality preference(s) (best, worst, 4k/2160p, 1440p, 1080p, 720p, 480p, 360p, hd, sd). Can be specified multiple times in priority order, e.g. "-q 1080p -q best" picks 1080p when available, otherwise the highest quality.',
  },
};

export const argBooleans: string[] = Object.entries(OPTION_SCHEMA)
  .filter(([, s]) => s.type === "boolean")
  .map(([k]) => k);

export const argDefaults: Record<string, unknown> = Object.fromEntries(
  Object.entries(OPTION_SCHEMA)
    .filter(([, s]) => s.default !== undefined)
    .map(([k, s]) => [k, s.default]),
);

const argStrings: string[] = Object.entries(OPTION_SCHEMA)
  .filter(([, s]) => s.type === "string" || s.type === "string[]")
  .map(([k]) => k);

export const argAlias: Record<string, string | string[]> = Object.fromEntries(
  Object.entries(OPTION_SCHEMA)
    .filter(([, s]) => s.alias !== undefined)
    .map(([k, s]) => [k, s.alias!]),
);

const argCollect: string[] = Object.entries(OPTION_SCHEMA)
  .filter(([, s]) => s.type === "string[]")
  .map(([k]) => k);

export const argDescriptions: Record<string, string> = Object.fromEntries(
  Object.entries(OPTION_SCHEMA).map(([k, s]) => [k, s.description]),
);

export const argRequired: string[] = Object.entries(OPTION_SCHEMA)
  .filter(([, s]) => s.required)
  .map(([k]) => k);

export const argNoSave: string[] = Object.entries(OPTION_SCHEMA)
  .filter(([, s]) => s.noSave)
  .map(([k]) => k);

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
