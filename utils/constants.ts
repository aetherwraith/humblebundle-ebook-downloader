import packageInfo from "../deno.json" with { type: "json" };
import { ParseOptions } from "@std/cli/parse-args";
import { Platform } from "./types.ts";
import { RetryOptions } from "@std/async/retry";

export const SUPPORTED_FORMATS = ["cbz", "epub", "pdf_hd", "pdf", "mobi"];
export const optionsFileName = "options.json";
export const cacheFileName = "checksums.json";

export const version = packageInfo.version;
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

const argBooleans = ["dedup", "bundleFolders"];
const argDefaults = {
  dedup: true,
  bundleFolders: true,
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
