import packageInfo from "../deno.json" with { type: "json" };
import { ParseOptions } from "@std/cli/parse-args";

export const SUPPORTED_FORMATS = ["cbz", "epub", "pdf_hd", "pdf", "mobi"];
export const SUPPORTED_PLATFORMS = ["linux", "mac", "windows"];
export const optionsFileName = "options.json";
export const cacheFileName = "checksums.json";
export const bundlesBar = "bundles";

export const version = packageInfo.version;
export const userAgent = `HumbleBundle-Ebook-Downloader/${version}`;

const argBooleans = ["dedup", "bundleFolders"];
const argDefaults = {
  dedup: true,
  bundleFolders: true,
  downloadLimit: 1,
  format: SUPPORTED_FORMATS,
  platform: SUPPORTED_PLATFORMS,
};
const argStrings = ["downloadFolder", "authToken"];
const argAlias = {
  downloadFolder: "d",
  downloadLimit: "l",
  authToken: "t",
  format: "f",
  platform: "p",
};
const argCollect = ["format", "platform"];
export const argDescriptions = {
  dedup: "Dedup the downloads",
  bundleFolders: "Arrange downloads in bundle folders",
  downloadFolder: "Download folder",
  downloadLimit: "Parallel download limit",
  authToken:
    "You must specify your authentication cookie from your browser (_simpleauth_sess)",
  format:
    'Format(s) to download separated by ",". Will prioritise in the order given, i.e. if you say "cbz,pdf" will download cbz format or pdf if cbz does not exist, unless --no-dedup is specified.',
  platform:
    'Platform(s) to download separated by ",". Will prioritise in the order given, i.e. if you say "linux,win" will download linux format or win if linux does not exist, unless --no-dedup is specified.',
};
export const argRequired = ["downloadFolder", "authToken"];
export const argNoSave = ["downloadFolder", "authToken"];

export const parseOptions: ParseOptions = {
  boolean: argBooleans,
  negatable: argBooleans,
  default: argDefaults,
  string: argStrings,
  alias: argAlias,
  collect: argCollect,
};
