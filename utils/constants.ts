import packageInfo from "../deno.json" with { type: "json" };
import { ParseOptions } from "@std/cli/parse-args";

export interface Options {
  dedup: boolean;
  bundleFolders: boolean;
  parallel: number;
  format: string;
  platform: string;
  command: string;
  authToken: string;
  downloadFolder: string;
}

export const SUPPORTED_FORMATS = ["cbz", "epub", "pdf_hd", "pdf", "mobi"];
export const SUPPORTED_PLATFORMS = ["linux", "mac", "windows"];
export const optionsFileName = "options.json";
export const cacheFileName = "checksums.json";

export const version = packageInfo.version;
export const userAgent = `HumbleBundle-Ebook-Downloader/${version}`;

export const COMMANDS = {
  all: "all",
  checksums: "checksums",
  cleanup: "cleanup",
  cleanupebooks: "cleanupebooks",
  cleanuptrove: "cleanuptrove",
  ebooks: "ebooks",
  trove: "trove",
};

const argBooleans = ["dedup", "bundleFolders"];
const argDefaults = {
  dedup: true,
  bundleFolders: true,
  parallel: 1,
  format: SUPPORTED_FORMATS,
  platform: SUPPORTED_PLATFORMS,
};
const argStrings = ["downloadFolder", "authToken"];
const argAlias = {
  downloadFolder: "d",
  parallel: "l",
  authToken: "t",
  format: "f",
  platform: "p",
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
