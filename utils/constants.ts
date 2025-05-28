import { Platform } from "../types/bundle.ts";

export const SUPPORTED_FORMATS = ["cbz", "epub", "pdf_hd", "pdf", "mobi"];
export const optionsFileName = "options.json";
export const cacheFileName = "checksums.json";
export const version = "3.1.0";

// Network-related constants
export const NETWORK_RETRY_COUNT = 3;
export const NETWORK_RETRY_DELAY = 1000; // Initial delay in ms

export const userAgent = `HumbleBundle-Ebook-Downloader/${version}`;

export const COMMANDS = {
  all: "all",
  checksums: "checksums",
  cleanup: "cleanup",
  cleanupEbooks: "cleanupebooks",
  cleanupTrove: "cleanuptrove",
  ebooks: "ebooks",
  trove: "trove",
};

const argBooleans = [
  "dedup",
  "bundleFolders",
  "productFolders",
  "humanFileNames",
];

const argDefaults = {
  dedup: true,
  bundleFolders: true,
  productFolders: true,
  humanFileNames: false,
  parallel: 1,
  format: SUPPORTED_FORMATS,
  platform: Object.values(Platform),
};

const argStrings = ["downloadFolder", "authToken"];

const argAlias = {
  downloadFolder: "d",
  parallel: "l",
  authToken: "t",
  format: "f",
  platform: "p",
  bundleFolders: "b",
};

const argCollect = ["format", "platform"];

export const argDescriptions = {
  dedup: "Dedup the downloads",
  bundleFolders: "Arrange downloads in bundle folders",
  productFolders: "Individual product folders",
  humanFileNames: "Use human readable file names",
  downloadFolder: "Download folder",
  parallel: "Parallel limit",
  authToken: "Authentication cookie from your browser (_simpleauth_sess)",
  format:
    'Format(s) to download. Can be specified multiple times. Will prioritise in the order given, i.e. if you say "-f cbz -f pdf" will download cbz format or pdf if cbz does not exist, unless --no-dedup is specified.',
  platform:
    'Platform(s) to download. Can be specified multiple times. Will prioritise in the order given, i.e. if you say "-p linux -p win" will download linux format or win if linux does not exist, unless --no-dedup is specified.',
};

export const argRequired = ["downloadFolder"];
export const argNoSave = ["downloadFolder", "authToken"];

export const parseOptions = {
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
