import { resolve } from "@std/path";
import { DownloadInfo, Options } from "../types/general.ts";

export const COMPOUND_EXTENSIONS = [
  ".hd.pdf",
  ".hq.pdf",
  ".tar.gz",
  ".tar.bz2",
  ".tar.xz",
];

/**
 * Strips the file extension (including compound extensions like `.hd.pdf` or `.tar.gz`,
 * and `.torrent` suffixes) from a file path or filename.
 */
const EXT_STRIP_RE = /\.[^./\\]+$/;

export function stripFileExtension(filePath: string): string {
  const lower = filePath.toLowerCase();
  const working = lower.endsWith(".torrent")
    ? filePath.slice(0, -".torrent".length)
    : filePath;
  const workingLower = lower.endsWith(".torrent")
    ? lower.slice(0, -".torrent".length)
    : lower;
  for (const compound of COMPOUND_EXTENSIONS) {
    if (workingLower.endsWith(compound)) {
      return working.slice(0, -compound.length);
    }
  }
  return working.replace(EXT_STRIP_RE, "");
}

/**
 * Replaces a file's extension (aware of compound extensions like `.hd.pdf` or `.tar.gz`)
 * with `newExt` (e.g. `".opf"` or `".jpg"`).
 */
export function replaceFileExtension(filePath: string, newExt: string): string {
  const prefixExt = newExt.startsWith(".") ? newExt : `.${newExt}`;
  return `${stripFileExtension(filePath)}${prefixExt}`;
}

/**
 * Normalizes a bundle identifier, UUID, legacy gamekey, or Humble Bundle URL
 * (e.g. `https://www.humblebundle.com/home/library/<uuid>` or `https://www.humblebundle.com/downloads?key=XYZ`)
 * into a clean key string.
 */
export function normalizeBundleKey(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (
    trimmed.includes("://") || trimmed.includes("key=") ||
    trimmed.includes("/home/library/")
  ) {
    try {
      const parsed = new URL(
        trimmed.includes("://")
          ? trimmed
          : trimmed.startsWith("/")
          ? `https://www.humblebundle.com${trimmed}`
          : `https://www.humblebundle.com/?${trimmed}`,
      );
      const keyParam = parsed.searchParams.get("key");
      if (keyParam) return keyParam.trim();
      const libMatch = parsed.pathname.match(
        /\/home\/library\/((?:group\/)?[^/?#]+)/i,
      );
      if (libMatch?.[1]) return libMatch[1].trim();
    } catch {
      const m = trimmed.match(/[?&]key=([^&#\s]+)/i);
      if (m?.[1]) return m[1].trim();
    }
  }
  return trimmed;
}

/**
 * Parses a cookie input (Netscape `cookies.txt` content, raw `Cookie:` header string,
 * `name=value` cookie pairs, or a legacy bare `_simpleauth_sess` token) into a valid `Cookie` header string.
 */
export function parseCookieInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";

  // 1. Netscape cookies.txt format (tab-separated or starting with `#`)
  if (trimmed.includes("\t") || trimmed.startsWith("#")) {
    const nowSec = Math.floor(Date.now() / 1000);
    const pairs: string[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      const l = line.trim();
      if (!l || (l.startsWith("#") && !l.startsWith("#HttpOnly_"))) continue;
      const clean = l.replace(/^#HttpOnly_/, "");
      const parts = clean.split(/\t+/);
      if (parts.length >= 7) {
        const domain = parts[0].toLowerCase();
        const expires = Number(parts[4]);
        if (expires > 0 && expires < nowSec) continue;
        if (domain.includes("humblebundle.com")) {
          pairs.push(`${parts[5].trim()}=${parts[6].trim()}`);
        }
      } else if (l.includes("_simpleauth_sess")) {
        const wsParts = l.split(/[ \t]+/);
        const val = wsParts[wsParts.length - 1]?.trim();
        if (val) pairs.push(`_simpleauth_sess="${val.replace(/^"|"$/g, "")}"`);
      }
    }
    if (pairs.length > 0) {
      return pairs.join("; ");
    }
  }

  // 2. Raw Cookie header or semicolon/newline-separated `key=value` pairs
  const singleLine = trimmed
    .replace(/\r?\n/g, "; ")
    .replace(/^cookie:\s*/i, "")
    .trim();
  if (
    singleLine.includes(";") ||
    /^(ory_session_|_simpleauth_sess|csrf_)/i.test(singleLine)
  ) {
    return singleLine;
  }
  // Check if `key=value` where key is a valid cookie identifier (not base64 padding `==`)
  const eqIdx = singleLine.indexOf("=");
  if (
    eqIdx > 0 && /^[a-zA-Z_][a-zA-Z0-9_$-]*$/.test(singleLine.slice(0, eqIdx))
  ) {
    return singleLine;
  }

  // 3. Legacy bare `_simpleauth_sess` value
  return `_simpleauth_sess="${singleLine.replace(/^"|"$/g, "")}";`;
}

/**
 * Parses an array of `--bundle-key` values (supporting comma-separated strings and URLs)
 * into a lowercase Set of gamekeys, or undefined if none are provided.
 */
export function parseBundleKeys(keys?: string[]): Set<string> | undefined {
  if (!keys || keys.length === 0) return undefined;
  const set = new Set<string>();
  for (const entry of keys) {
    for (const part of entry.split(",")) {
      const norm = normalizeBundleKey(part).toLowerCase();
      if (norm) {
        set.add(norm);
        if (norm.startsWith("group/")) {
          set.add(norm.slice(6));
        } else if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(norm)) {
          set.add(`group/${norm}`);
        }
      }
    }
  }
  return set.size > 0 ? set : undefined;
}

const ILLEGAL_RE = /[/?<>\\:*|"]/g;
// deno-lint-ignore no-control-regex
const CONTROL_RE = /[\x00-\x1f\x80-\x9f]/g;
const RESERVED_RE = /^\.+$/;
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const WINDOWS_TRAILING_RE = /[. ]+$/;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Truncates a string so its UTF-8 byte length does not exceed `byteLength`.
 */
function truncateUtf8Bytes(str: string, byteLength: number): string {
  // Fast path: each UTF-16 code unit encodes to at most 3 UTF-8 bytes (or 4 for surrogate pairs).
  // If str.length * 4 <= byteLength, UTF-8 byte length is guaranteed <= byteLength.
  if (str.length * 4 <= byteLength) return str;
  const bytes = textEncoder.encode(str);
  if (bytes.byteLength <= byteLength) return str;
  // Walk backwards from byteLength to avoid splitting a multi-byte UTF-8 sequence
  let end = byteLength;
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) {
    end--;
  }
  return textDecoder.decode(bytes.subarray(0, end));
}

/**
 * Sanitizes a string to be safe for use as a file or directory name across
 * Windows, macOS, and Linux, stripping illegal/control characters and truncating to 255 UTF-8 bytes.
 *
 * @param input Raw filename string
 * @param replacement Replacement string for illegal characters (default "")
 * @returns Safe filename string
 */
export function sanitizeFilename(input: string, replacement = ""): string {
  const sanitized = input
    .replace(ILLEGAL_RE, replacement)
    .replace(CONTROL_RE, replacement)
    .replace(RESERVED_RE, replacement)
    .replace(WINDOWS_RESERVED_RE, replacement)
    .replace(WINDOWS_TRAILING_RE, replacement);
  return truncateUtf8Bytes(sanitized, 255);
}

export const COMIC_BOOK_FORMATS = ["cbz", "cbr", "cb7", "cbt", "cba"];

/**
 * Expands format preference tokens such as `"cb?"` into ordered concrete comic archive
 * formats (`cbz` -> `cbr` -> `cb7` -> `cbt` -> `cba`), preserving user priority order
 * and deduplicating tokens.
 */
export function expandFormatPreferences(formats: string[]): string[] {
  const expanded: string[] = [];
  const seen = new Set<string>();
  const add = (fmt: string) => {
    const norm = fmt.trim().toLowerCase();
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      expanded.push(norm);
    }
  };
  for (const raw of formats) {
    const lower = raw.trim().toLowerCase();
    if (lower === "cb?") {
      for (const cb of COMIC_BOOK_FORMATS) add(cb);
    } else {
      add(normalizeFormat(lower));
    }
  }
  return expanded;
}

/**
 * Normalizes format names found in Humble Bundle struct names to canonical internal formats.
 * e.g., 'PDF (HD)' or 'PDF (HQ)' -> 'pdf_hd', 'Download' -> 'pdf', '.cbz' -> 'cbz', '.cbr' -> 'cbr'.
 *
 * @param format Raw format string
 * @returns Canonical format string
 */
export function normalizeFormat(format: string): string {
  const lower = format.trim().toLowerCase();
  switch (lower) {
    case ".cbz":
    case ".cbr":
    case ".cb7":
    case ".cbt":
    case ".cba":
      return lower.slice(1);
    case "pdf (hq)":
    case "pdf (hd)":
      return "pdf_hd";
    case "download":
      return "pdf";
    default:
      return lower;
  }
}

/**
 * Returns the file extension corresponding to a canonical format.
 *
 * @param format Canonical format name
 * @returns Extension with leading period (e.g. '.epub', '.hd.pdf')
 */
export function getExtension(format: string): string {
  switch (format.toLowerCase()) {
    case "pdf_hd":
      return ".hd.pdf";
    default:
      return `.${format}`;
  }
}

/**
 * Detects a canonical audio codec/format (`flac`, `alac`, `wav`, `aiff`, `m4b`, `m4a`,
 * `aac`, `opus`, `ogg`, `mp3`, `rex`) from a Humble struct name and/or download URL filename.
 * Returns `undefined` when the struct is an untagged archive (e.g. generic `ZIP:ost.zip`).
 */
const AUDIO_FORMAT_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bflac\d*\b|[a-z0-9_-]flac\d*(?:[_.-]|\b|$)/i, "flac"],
  [/\balac\d*\b|[a-z0-9_-]alac\d*(?:[_.-]|\b|$)/i, "alac"],
  [
    /\bwav(?:24bit)?\b|[a-z0-9_-]wav(?:24bit)?(?:[_.-]|\b|$)|\.wav$/i,
    "wav",
  ],
  [/\baiff?\b|[_-]aiff?(?:[_.-]|\b|$)|\.aiff?$/i, "aiff"],
  [/\bm4b\b|[_-]m4b(?:[_.-]|\b|$)|\.m4b$/i, "m4b"],
  [/\bm4a\b|[_-]m4a(?:[_.-]|\b|$)|\.m4a$/i, "m4a"],
  [/\baac\d*\b|[a-z0-9_-]aac\d*(?:[_.-]|\b|$)|\.aac$/i, "aac"],
  [/\bopus\b|[_-]opus(?:[_.-]|\b|$)|\.opus$/i, "opus"],
  [/\bogg\b|[_-]ogg(?:[_.-]|\b|$)|\.ogg$/i, "ogg"],
  [
    /\bmp3\d*\b|[a-z0-9_-]mp3\d*(?:[_.-]|\b|$)|\b320cbr\b|[_-]320cbr(?:[_.-]|\b|$)|\.mp3$/i,
    "mp3",
  ],
  [/[_-](?:rex|rmx|rx2)(?:[_.-]|$)|\.(?:rex|rmx|rx2)$/i, "rex"],
];

function extractLastPathSegment(urlPath: string): string {
  const qIdx = urlPath.indexOf("?");
  const hIdx = urlPath.indexOf("#");
  let end = urlPath.length;
  if (qIdx !== -1 && qIdx < end) end = qIdx;
  if (hIdx !== -1 && hIdx < end) end = hIdx;
  const cleanPath = urlPath.slice(0, end);
  const slashIdx = cleanPath.lastIndexOf("/");
  const rawSeg = slashIdx === -1 ? cleanPath : cleanPath.slice(slashIdx + 1);
  try {
    return decodeURIComponent(rawSeg);
  } catch {
    return rawSeg;
  }
}

export function detectAudioFormat(
  structName?: string,
  urlPath?: string,
): string | undefined {
  const fileBase = urlPath ? extractLastPathSegment(urlPath) : "";
  const combined = `${structName ?? ""} ${fileBase}`;
  for (const [re, fmt] of AUDIO_FORMAT_RULES) {
    if (re.test(combined)) return fmt;
  }
  return undefined;
}

/**
 * Normalizes a user-specified audio format preference token.
 */
export function normalizeAudioFormat(format: string): string {
  const lower = format.trim().toLowerCase().replace(/^\./, "");
  if (lower === "aif") return "aiff";
  if (lower === "vorbis") return "ogg";
  if (lower === "rmx" || lower === "rx2") return "rex";
  return lower;
}

const VIDEO_QUALITY_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(2160p|4k|uhd)\b|2160p|(?:^|[a-z_-])2160p?(?:[_.-]|$)/i, "2160p"],
  [/\b(1440p|2k|qhd)\b|1440p|(?:^|[a-z_-])1440p?(?:[_.-]|$)/i, "1440p"],
  [/\b(1080p|fhd|full\s*hd)\b|1080p|(?:^|[a-z_-])1080p?(?:[_.-]|$)/i, "1080p"],
  [/\b720p\b|720p|(?:^|[a-z_-])720p?(?:[_.-]|$)/i, "720p"],
  [/\b480p\b|480p|(?:^|[a-z_-])480p?(?:[_.-]|$)/i, "480p"],
  [/\b360p\b|360p|(?:^|[a-z_-])360p?(?:[_.-]|$)/i, "360p"],
  [/\bhd\b/i, "hd"],
  [/\bsd\b/i, "sd"],
];

/**
 * Normalizes a video quality string or struct label/filename to a canonical resolution tier.
 * Recognizes: '2160p' (or '4k', 'uhd'), '1440p' ('2k', 'qhd'), '1080p' ('full hd', 'fhd'),
 * '720p', '480p', '360p', 'hd', 'sd' (including filenames like `Show1080.mp4` or `Show-720_123.zip`).
 *
 * @param label Struct name or filename
 * @returns Canonical quality string or undefined if none detected
 */
export function detectVideoQuality(label: string): string | undefined {
  for (const [re, tier] of VIDEO_QUALITY_RULES) {
    if (re.test(label)) return tier;
  }
  return undefined;
}

/**
 * Normalizes a user-specified video quality preference token.
 * Maps '4k' -> '2160p', preserves 'best', 'worst', '1080p', etc.
 */
export function normalizeVideoQuality(quality: string): string {
  const lower = quality.trim().toLowerCase();
  if (lower === "4k" || lower === "uhd") return "2160p";
  if (lower === "2k" || lower === "qhd") return "1440p";
  if (lower === "fhd") return "1080p";
  return lower;
}

const QUALITY_RANK: Record<string, number> = {
  "2160p": 600,
  "1440p": 500,
  "1080p": 400,
  "720p": 300,
  "hd": 250,
  "480p": 200,
  "sd": 150,
  "360p": 100,
};

/**
 * Numeric rank for a video struct used when sorting by quality ("best" or "worst").
 * Primarily uses file_size when present, falling back to resolution rank.
 */
export function getVideoQualityScore(
  fileSize?: number,
  structName?: string,
  urlPath?: string,
): number {
  if (fileSize && fileSize > 0) return fileSize;
  const detected = detectVideoQuality(`${structName ?? ""} ${urlPath ?? ""}`);
  return detected ? (QUALITY_RANK[detected] ?? 0) : 0;
}

/**
 * Parses a human-readable size string (e.g. "500MB", "2.5 GB", "1024KB", "1048576")
 * into bytes. Returns undefined if the input is empty or invalid.
 */
const SIZE_RE = /^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib|tb|tib)?$/i;
const SIZE_MULTIPLIERS: Record<string, number> = {
  b: 1,
  kb: 1000,
  kib: 1024,
  mb: 1000 ** 2,
  mib: 1024 ** 2,
  gb: 1000 ** 3,
  gib: 1024 ** 3,
  tb: 1000 ** 4,
  tib: 1024 ** 4,
};

export function parseSize(sizeStr?: string): number | undefined {
  if (!sizeStr) return undefined;
  const match = sizeStr.trim().match(SIZE_RE);
  if (!match) return undefined;
  const value = parseFloat(match[1]);
  if (isNaN(value) || value < 0) return undefined;

  const unit = (match[2] ?? "b").toLowerCase();
  return Math.floor(value * (SIZE_MULTIPLIERS[unit] ?? 1));
}

/**
 * Compiles a filter pattern once into a reusable predicate function
 * (supports case-insensitive substring or regex).
 */
export function createFilterMatcher(
  filterPattern?: string,
): (...candidates: (string | undefined)[]) => boolean {
  if (!filterPattern) return () => true;
  const trimmed = filterPattern.trim();
  if (!trimmed) return () => true;

  let regex: RegExp | undefined;
  try {
    regex = new RegExp(trimmed, "i");
  } catch {
    // Fallback to plain substring match if regex syntax is invalid
  }

  const lowerPattern = trimmed.toLowerCase();
  return (...candidates: (string | undefined)[]): boolean => {
    for (const candidate of candidates) {
      if (!candidate) continue;
      if (
        regex
          ? regex.test(candidate)
          : candidate.toLowerCase().includes(lowerPattern)
      ) {
        return true;
      }
    }
    return false;
  };
}

/**
 * Checks if a bundle or item name matches the user's `--filter` pattern
 * (supports case-insensitive substring or regex).
 */
export function matchesFilter(
  filterPattern: string | undefined,
  ...candidates: (string | undefined)[]
): boolean {
  return createFilterMatcher(filterPattern)(...candidates);
}

/**
 * Compiles an `--exclude` pattern once into a reusable predicate function
 * that returns true if any candidate matches the excluded substring or regex.
 */
export function createExcludeMatcher(
  excludePattern?: string,
): (...candidates: (string | undefined)[]) => boolean {
  if (!excludePattern || !excludePattern.trim()) return () => false;
  return createFilterMatcher(excludePattern);
}

/**
 * Parses a date string (e.g. "2025-01-01" or ISO timestamp) into a Date object.
 * When `endOfDay` is true and a date-only string ("YYYY-MM-DD") is provided,
 * sets the time to 23:59:59.999 UTC so the entire day is included.
 */
const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDateOption(
  dateStr?: string,
  endOfDay = false,
): Date | undefined {
  if (!dateStr || !dateStr.trim()) return undefined;
  const trimmed = dateStr.trim();
  const isDateOnly = ISO_DATE_ONLY_RE.test(trimmed);
  const parsed = new Date(
    isDateOnly
      ? `${trimmed}T${endOfDay ? "23:59:59.999Z" : "00:00:00.000Z"}`
      : trimmed,
  );
  if (isNaN(parsed.getTime())) return undefined;
  return parsed;
}

// deno-lint-ignore no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

/**
 * Strips ANSI terminal escape sequences from a string for clean plain-text file logging.
 */
export function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "");
}

export interface OutputTemplateVars {
  bundle: string;
  publisher?: string;
  product: string;
  format: string;
  ext: string;
  year: string;
  month?: string;
  day?: string;
  date?: string;
  gamekey?: string;
  platform?: string;
  filename: string;
}

const TEMPLATE_TOKEN_RE =
  /\{(bundle|publisher|product|title|format|ext|year|month|day|date|gamekey|platform|filename)\}/gi;
const PATH_SPLIT_RE = /[/\\]+/;

/**
 * Resolves a custom `--output-template` string into `{ downloadPath, fileName, filePath }`.
 * Supported placeholders: `{bundle}`, `{publisher}`, `{product}` (or `{title}`), `{format}`, `{ext}`, `{year}`, `{month}`, `{day}`, `{date}`, `{gamekey}`, `{platform}`, `{filename}`.
 */
export function resolveOutputTemplate(
  downloadFolder: string,
  template: string,
  vars: OutputTemplateVars,
): { downloadPath: string; fileName: string; filePath: string } {
  const cleanExt = vars.ext.replace(/^\./, "");
  const dotExt = cleanExt ? `.${cleanExt}` : "";
  const cache: Record<string, string> = {};

  const getToken = (rawKey: string): string => {
    const key = rawKey.toLowerCase();
    if (key in cache) return cache[key];
    let val = "";
    switch (key) {
      case "bundle":
        val = sanitizeFilename(vars.bundle) || "Unknown Bundle";
        break;
      case "publisher":
        val = sanitizeFilename(vars.publisher || "Unknown Publisher") ||
          "Unknown Publisher";
        break;
      case "product":
      case "title":
        val = sanitizeFilename(vars.product) || "Unknown Product";
        break;
      case "format":
        val = sanitizeFilename(vars.format.toLowerCase()) || "file";
        break;
      case "ext":
        val = sanitizeFilename(cleanExt);
        break;
      case "year":
        val = sanitizeFilename(vars.year) || "0000";
        break;
      case "month":
        val = sanitizeFilename(vars.month ?? "01") || "01";
        break;
      case "day":
        val = sanitizeFilename(vars.day ?? "01") || "01";
        break;
      case "date":
        val = sanitizeFilename(vars.date ?? `${vars.year || "0000"}-01-01`);
        break;
      case "gamekey":
        val = sanitizeFilename(vars.gamekey ?? "") || "unknown";
        break;
      case "platform":
        val = sanitizeFilename((vars.platform ?? vars.format).toLowerCase()) ||
          "file";
        break;
      case "filename":
        val = sanitizeFilename(vars.filename);
        break;
    }
    cache[key] = val;
    return val;
  };

  const rendered = template.replace(
    TEMPLATE_TOKEN_RE,
    (_match, key: string) => getToken(key),
  );

  const segments = rendered
    .split(PATH_SPLIT_RE)
    .map((s) => sanitizeFilename(s.trim()))
    .filter(Boolean);

  if (segments.length === 0) {
    const fallbackName = sanitizeFilename(vars.filename);
    const downloadPath = resolve(downloadFolder);
    return {
      downloadPath,
      fileName: fallbackName,
      filePath: resolve(downloadPath, fallbackName),
    };
  }

  let fileName = segments.pop()!;
  if (
    dotExt &&
    !fileName.toLowerCase().endsWith(dotExt.toLowerCase())
  ) {
    const extBytes = new TextEncoder().encode(dotExt).length;
    const maxBaseBytes = Math.max(1, 255 - extBytes);
    const basePart =
      sanitizeFilename(truncateUtf8Bytes(fileName, maxBaseBytes)) ||
      "file";
    fileName = sanitizeFilename(`${basePart}${dotExt}`);
  } else {
    fileName = sanitizeFilename(fileName) || `file${dotExt}`;
  }
  const downloadPath = resolve(downloadFolder, ...segments);
  const filePath = resolve(downloadPath, fileName);
  return { downloadPath, fileName, filePath };
}

export interface CompiledItemFilters {
  hasSubsetFilter: boolean;
  matchesBundleKey: (gameKey: string) => boolean;
  matchesText: (...candidates: (string | undefined)[]) => boolean;
  matchesSize: (fileSize?: number) => boolean;
  matchesDate: (date: Date) => boolean;
}

/**
 * Pre-compiles bundle key, text include/exclude, byte size, and date range filters
 * from CLI `options` for fast reuse across thousands of catalog entries.
 */
export function compileItemFilters(
  options: Partial<Options>,
): CompiledItemFilters {
  const bundleKeySet = parseBundleKeys(options.bundleKey);
  const filterMatch = createFilterMatcher(options.filter);
  const excludeMatch = createExcludeMatcher(options.exclude);
  const maxBytes = parseSize(options.maxSize);
  const minBytes = parseSize(options.minSize);
  const sinceDate = parseDateOption(options.since, false);
  const beforeDate = parseDateOption(options.before, true);

  const hasSubsetFilter = Boolean(
    bundleKeySet ||
      options.filter ||
      options.exclude ||
      options.since ||
      options.before ||
      options.maxSize ||
      options.minSize,
  );

  return {
    hasSubsetFilter,
    matchesBundleKey: (gameKey: string) =>
      !bundleKeySet || bundleKeySet.has(gameKey.toLowerCase()),
    matchesText: (...candidates: (string | undefined)[]) =>
      filterMatch(...candidates) && !excludeMatch(...candidates),
    matchesSize: (fileSize?: number) => {
      if (fileSize === undefined) return true;
      if (maxBytes !== undefined && fileSize > maxBytes) return false;
      if (minBytes !== undefined && fileSize < minBytes) return false;
      return true;
    },
    matchesDate: (date: Date) => {
      if (sinceDate && date < sinceDate) return false;
      if (beforeDate && date > beforeDate) return false;
      return true;
    },
  };
}

const DOWNLOAD_NAME_COLLATOR = new Intl.Collator();

/**
 * Sorts resolved DownloadInfo items descending by file_size, breaking ties alphabetically by name.
 */
export function sortDownloads(downloads: DownloadInfo[]): DownloadInfo[] {
  return downloads.sort((a, b) =>
    (b.file_size || 0) - (a.file_size || 0) ||
    DOWNLOAD_NAME_COLLATOR.compare(a.name, b.name)
  );
}
