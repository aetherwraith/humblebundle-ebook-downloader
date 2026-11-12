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
export function stripFileExtension(filePath: string): string {
  let working = filePath;
  if (working.toLowerCase().endsWith(".torrent")) {
    working = working.slice(0, -".torrent".length);
  }
  const lower = working.toLowerCase();
  for (const compound of COMPOUND_EXTENSIONS) {
    if (lower.endsWith(compound)) {
      return working.slice(0, -compound.length);
    }
  }
  return working.replace(/\.[^./\\]+$/, "");
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
  if (trimmed.includes("://") || trimmed.includes("key=") || trimmed.includes("/home/library/")) {
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
    const pairs: string[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      const l = line.trim();
      if (!l || (l.startsWith("#") && !l.startsWith("#HttpOnly_"))) continue;
      const clean = l.replace(/^#HttpOnly_/, "");
      const parts = clean.split(/\t+/);
      if (parts.length >= 7) {
        const domain = parts[0].toLowerCase();
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
  if (singleLine.includes(";") || /^(ory_session_|_simpleauth_sess|csrf_)/i.test(singleLine)) {
    return singleLine;
  }
  // Check if `key=value` where key is a valid cookie identifier (not base64 padding `==`)
  const eqIdx = singleLine.indexOf("=");
  if (eqIdx > 0 && /^[a-zA-Z_][a-zA-Z0-9_$-]*$/.test(singleLine.slice(0, eqIdx))) {
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
export function detectAudioFormat(
  structName?: string,
  urlPath?: string,
): string | undefined {
  let fileBase = "";
  if (urlPath) {
    try {
      const parsed = new URL(urlPath, "https://www.humblebundle.com/");
      const segs = parsed.pathname.split("/");
      fileBase = decodeURIComponent(segs[segs.length - 1] ?? "");
    } catch {
      fileBase = urlPath;
    }
  }
  const combined = `${structName ?? ""} ${fileBase}`;
  if (/\bflac\d*\b|[a-z0-9_-]flac\d*(?:[_.-]|\b|$)/i.test(combined)) {
    return "flac";
  }
  if (/\balac\d*\b|[a-z0-9_-]alac\d*(?:[_.-]|\b|$)/i.test(combined)) {
    return "alac";
  }
  if (
    /\bwav(?:24bit)?\b|[a-z0-9_-]wav(?:24bit)?(?:[_.-]|\b|$)|\.wav$/i.test(
      combined,
    )
  ) {
    return "wav";
  }
  if (/\baiff?\b|[_-]aiff?(?:[_.-]|\b|$)|\.aiff?$/i.test(combined)) {
    return "aiff";
  }
  if (/\bm4b\b|[_-]m4b(?:[_.-]|\b|$)|\.m4b$/i.test(combined)) {
    return "m4b";
  }
  if (/\bm4a\b|[_-]m4a(?:[_.-]|\b|$)|\.m4a$/i.test(combined)) {
    return "m4a";
  }
  if (/\baac\d*\b|[a-z0-9_-]aac\d*(?:[_.-]|\b|$)|\.aac$/i.test(combined)) {
    return "aac";
  }
  if (/\bopus\b|[_-]opus(?:[_.-]|\b|$)|\.opus$/i.test(combined)) {
    return "opus";
  }
  if (/\bogg\b|[_-]ogg(?:[_.-]|\b|$)|\.ogg$/i.test(combined)) {
    return "ogg";
  }
  if (
    /\bmp3\d*\b|[a-z0-9_-]mp3\d*(?:[_.-]|\b|$)|\b320cbr\b|[_-]320cbr(?:[_.-]|\b|$)|\.mp3$/i
      .test(combined)
  ) {
    return "mp3";
  }
  if (/[_-](?:rex|rmx|rx2)(?:[_.-]|$)|\.(?:rex|rmx|rx2)$/i.test(combined)) {
    return "rex";
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

/**
 * Normalizes a video quality string or struct label/filename to a canonical resolution tier.
 * Recognizes: '2160p' (or '4k', 'uhd'), '1440p' ('2k', 'qhd'), '1080p' ('full hd', 'fhd'),
 * '720p', '480p', '360p', 'hd', 'sd' (including filenames like `Show1080.mp4` or `Show-720_123.zip`).
 *
 * @param label Struct name or filename
 * @returns Canonical quality string or undefined if none detected
 */
export function detectVideoQuality(label: string): string | undefined {
  const lower = label.toLowerCase();
  if (
    /\b(2160p|4k|uhd)\b/.test(lower) ||
    lower.includes("2160p") ||
    /(?:^|[a-z_-])2160p?(?:[_.-]|$)/.test(lower)
  ) {
    return "2160p";
  }
  if (
    /\b(1440p|2k|qhd)\b/.test(lower) ||
    lower.includes("1440p") ||
    /(?:^|[a-z_-])1440p?(?:[_.-]|$)/.test(lower)
  ) {
    return "1440p";
  }
  if (
    /\b(1080p|fhd|full\s*hd)\b/.test(lower) ||
    lower.includes("1080p") ||
    /(?:^|[a-z_-])1080p?(?:[_.-]|$)/.test(lower)
  ) {
    return "1080p";
  }
  if (
    /\b720p\b/.test(lower) ||
    lower.includes("720p") ||
    /(?:^|[a-z_-])720p?(?:[_.-]|$)/.test(lower)
  ) {
    return "720p";
  }
  if (
    /\b480p\b/.test(lower) ||
    lower.includes("480p") ||
    /(?:^|[a-z_-])480p?(?:[_.-]|$)/.test(lower)
  ) {
    return "480p";
  }
  if (
    /\b360p\b/.test(lower) ||
    lower.includes("360p") ||
    /(?:^|[a-z_-])360p?(?:[_.-]|$)/.test(lower)
  ) {
    return "360p";
  }
  if (/\bhd\b/.test(lower)) {
    return "hd";
  }
  if (/\bsd\b/.test(lower)) {
    return "sd";
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
export function parseSize(sizeStr?: string): number | undefined {
  if (!sizeStr) return undefined;
  const match = sizeStr.trim().match(
    /^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib|tb|tib)?$/i,
  );
  if (!match) return undefined;
  const value = parseFloat(match[1]);
  if (isNaN(value) || value < 0) return undefined;

  const unit = (match[2] ?? "b").toLowerCase();
  const multipliers: Record<string, number> = {
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
  return Math.floor(value * (multipliers[unit] ?? 1));
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
export function parseDateOption(
  dateStr?: string,
  endOfDay = false,
): Date | undefined {
  if (!dateStr || !dateStr.trim()) return undefined;
  const trimmed = dateStr.trim();
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
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
  filename: string;
}

/**
 * Resolves a custom `--output-template` string into `{ downloadPath, fileName, filePath }`.
 * Supported placeholders: `{bundle}`, `{publisher}`, `{product}` (or `{title}`), `{format}`, `{ext}`, `{year}`, `{filename}`.
 */
export function resolveOutputTemplate(
  downloadFolder: string,
  template: string,
  vars: OutputTemplateVars,
): { downloadPath: string; fileName: string; filePath: string } {
  const cleanExt = vars.ext.replace(/^\./, "");
  const dotExt = cleanExt ? `.${cleanExt}` : "";
  const replacements: Record<string, string> = {
    bundle: sanitizeFilename(vars.bundle) || "Unknown Bundle",
    publisher: sanitizeFilename(vars.publisher || "Unknown Publisher") ||
      "Unknown Publisher",
    product: sanitizeFilename(vars.product) || "Unknown Product",
    title: sanitizeFilename(vars.product) || "Unknown Product",
    format: sanitizeFilename(vars.format.toLowerCase()) || "file",
    ext: sanitizeFilename(cleanExt),
    year: sanitizeFilename(vars.year) || "0000",
    filename: sanitizeFilename(vars.filename),
  };

  const rendered = template.replace(
    /\{(bundle|publisher|product|title|format|ext|year|filename)\}/gi,
    (_match, key: string) => replacements[key.toLowerCase()] ?? "",
  );

  const segments = rendered
    .split(/[/\\]+/)
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
    fileName = sanitizeFilename(`${fileName}${dotExt}`);
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
export function compileItemFilters(options: Partial<Options>): CompiledItemFilters {
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

/**
 * Sorts resolved DownloadInfo items descending by file_size, breaking ties alphabetically by name.
 */
export function sortDownloads(downloads: DownloadInfo[]): DownloadInfo[] {
  return downloads.sort((a, b) =>
    (b.file_size || 0) - (a.file_size || 0) || a.name.localeCompare(b.name)
  );
}
