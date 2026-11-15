import { delay } from "@std/async/delay";
import { basename } from "@std/path";
import {
  MultiBarWrapper,
  progressDebug,
  SingleBarWrapper,
} from "./progressWrapper.ts";
import { COMMANDS, retryOptions, userAgent } from "./constants.ts";
import { readJsonFile, writeJsonFile } from "./fileUtils.ts";
import { parseBundleKeys, parseCookieInput } from "./generic.ts";

import { DownloadInfo, Options, Queues, Totals } from "../types/general.ts";
import { Download as TroveDownload, Trove } from "../types/trove.ts";
import {
  Bundle,
  Category,
  Download as BundleDownload,
  DownloadStruct,
  Platform,
  SubProduct,
} from "../types/bundle.ts";

// Base Humble Bundle web origin
const BASE_URL = "https://www.humblebundle.com";
const LIBRARY_PATH = "/home/library";

// Cache of in-flight or completed bundle detail refreshes keyed by gameKey
const refreshedBundlesCache = new Map<string, Promise<Bundle>>();

// Cache of discovered Next.js Server Action hashes & chunk JS contents
const nextActionIdCache = new Map<string, string>();
const chunkTextCache = new Map<string, Promise<string>>();
const knownChunkPathsByRoute = new Map<string, string[]>();

// Signed URL caches (with expiration timestamps) for Vault & Bundle entitlements
interface CachedSignedMap {
  // subproductMachineName -> downloadKey -> encodedRelativePath -> signedUrl
  signedUrls: Record<string, Record<string, Record<string, string>>>;
  expiresAtMs: number;
}
const vaultSignedUrlsCache = new Map<string, Promise<CachedSignedMap>>();
const entitlementSignedUrlsCache = new Map<string, Promise<CachedSignedMap>>();

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Encodes each `/`-separated path segment per RFC 3986 (matching Humble's Next.js client lookup key).
 */
export function encodeRfc3986Path(relUrl: string): string {
  return relUrl
    .split("/")
    .map((seg) =>
      encodeURIComponent(seg).replace(
        /[!'()*]/g,
        (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
      )
    )
    .join("/");
}

/**
 * Extracts concatenated React Flight (`self.__next_f.push([1, "..."])`) bytes from a Next.js HTML document.
 */
export function extractFlightBytesFromHtml(html: string): Uint8Array {
  const chunks: string[] = [];
  const re = /self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)/g;
  for (const m of html.matchAll(re)) {
    try {
      chunks.push(JSON.parse(m[1]));
    } catch {
      // Ignore malformed script fragment
    }
  }
  return textEncoder.encode(chunks.join(""));
}

/**
 * Byte-accurate React Flight (Next.js RSC / Server Action response) stream parser.
 * Supports both raw UTF-8 byte length chunks (`<id>:T<hexLen>,<bytes>`) and JSON rows (`<id>:<json>\n`).
 */
export function parseRscStream(bytes: Uint8Array): Map<string, unknown> {
  const rows = new Map<string, unknown>();
  let pos = 0;
  const len = bytes.length;

  while (pos < len) {
    let colon = pos;
    while (colon < len && bytes[colon] !== 0x3a && bytes[colon] !== 0x0a) {
      colon++;
    }
    if (colon >= len) break;
    if (bytes[colon] === 0x0a) {
      pos = colon + 1;
      continue;
    }
    const id = textDecoder.decode(bytes.subarray(pos, colon)).trim();
    pos = colon + 1;
    if (pos >= len) break;

    // Raw text chunk: `T<hexByteLength>,<utf8Bytes>`
    if (bytes[pos] === 0x54 /* 'T' */) {
      let comma = pos + 1;
      while (comma < len && bytes[comma] !== 0x2c && comma - pos < 16) {
        comma++;
      }
      if (comma < len && bytes[comma] === 0x2c) {
        const hexStr = textDecoder.decode(bytes.subarray(pos + 1, comma));
        const byteLen = parseInt(hexStr, 16);
        if (!isNaN(byteLen) && byteLen >= 0) {
          const start = comma + 1;
          const end = Math.min(len, start + byteLen);
          rows.set(id, textDecoder.decode(bytes.subarray(start, end)));
          pos = end;
          continue;
        }
      }
    }

    let nl = pos;
    while (nl < len && bytes[nl] !== 0x0a) nl++;
    const rawVal = textDecoder.decode(bytes.subarray(pos, nl));
    pos = nl + 1;

    const fc = rawVal[0];
    if (fc === "[" || fc === "{" || fc === '"') {
      try {
        rows.set(id, JSON.parse(rawVal));
      } catch {
        rows.set(id, rawVal);
      }
    } else {
      rows.set(id, rawVal);
    }
  }

  return rows;
}

/**
 * Resolves `$` Flight row references (`$undefined`, `$Lxx`, `$@xx`, `$xx`) within a parsed RSC value.
 */
export function resolveFlightRefs(
  val: unknown,
  rows: Map<string, unknown>,
  depth = 0,
  memo = new Map<string, unknown>(),
): unknown {
  if (depth > 16) return val;
  if (typeof val === "string") {
    if (val === "$undefined") return undefined;
    if (val.startsWith("$") && !val.startsWith("$$")) {
      const refId = val.slice(1).replace(/^[L@]/, "");
      if (memo.has(refId)) return memo.get(refId);
      if (rows.has(refId)) {
        const rawRef = rows.get(refId);
        memo.set(refId, rawRef);
        const resolved = resolveFlightRefs(rawRef, rows, depth + 1, memo);
        memo.set(refId, resolved);
        return resolved;
      }
    }
    return val;
  }
  if (Array.isArray(val)) {
    return val.map((v) => resolveFlightRefs(v, rows, depth + 1, memo));
  }
  if (val && typeof val === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out[k] = resolveFlightRefs(v, rows, depth + 1, memo);
    }
    return out;
  }
  return val;
}

function extractScriptChunkPaths(text: string): string[] {
  const paths = new Set<string>();
  for (
    const m of text.matchAll(
      /(?:\/_next\/|(?<="))static\/chunks\/[^"'>\s\\]+\.js(?:\?[^"'>\s\\]*)?/g,
    )
  ) {
    const raw = m[0];
    paths.add(raw.startsWith("/_next/") ? raw : `/_next/${raw}`);
  }
  return [...paths];
}

function registerChunkPaths(routeKey: string, text: string): string[] {
  const paths = extractScriptChunkPaths(text);
  if (paths.length > 0) {
    const existing = knownChunkPathsByRoute.get(routeKey) ?? [];
    const merged = [...new Set([...existing, ...paths])];
    knownChunkPathsByRoute.set(routeKey, merged);
    return merged;
  }
  return knownChunkPathsByRoute.get(routeKey) ?? [];
}

/**
 * Performs an HTTP fetch with automatic retries for transient network errors,
 * HTTP 429 Too Many Requests (respecting Retry-After), and 5xx server errors.
 */
export async function fetchWithRetry(
  url: string | URL,
  init?: RequestInit,
  maxAttempts = retryOptions.maxAttempts ?? 3,
): Promise<Response> {
  let attempt = 0;
  let lastError: unknown;
  while (attempt < maxAttempts) {
    attempt++;
    try {
      const response = await fetch(url, init);
      if (
        (response.status === 429 || response.status >= 500) &&
        attempt < maxAttempts
      ) {
        const retryAfterHeader = response.headers.get("retry-after");
        const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : NaN;
        const waitMs = !isNaN(retryAfterSec) && retryAfterSec > 0
          ? Math.min(retryAfterSec * 1000, 10000)
          : (retryOptions.minTimeout ?? 10) * Math.pow(2, attempt - 1);
        await response.body?.cancel().catch(() => {});
        await delay(waitMs);
        continue;
      }
      return response;
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts) {
        throw err;
      }
      const waitMs = (retryOptions.minTimeout ?? 10) * Math.pow(2, attempt - 1);
      await delay(waitMs);
    }
  }
  throw lastError ?? new Error(`Failed to fetch ${url}`);
}

/**
 * Builds HTTP headers including user agent and parsed Humble Bundle session cookies.
 *
 * @param options Runtime options containing authToken (Netscape cookies.txt, Cookie header, or token)
 * @returns Headers instance
 */
let lastAuthTokenRaw: string | undefined;
let lastAuthTokenCookie = "";

function getMemoizedCookieHeader(authToken: string): string {
  if (authToken !== lastAuthTokenRaw) {
    lastAuthTokenRaw = authToken;
    lastAuthTokenCookie = parseCookieInput(authToken);
  }
  return lastAuthTokenCookie;
}

export function getRequestHeaders(options: Options): Headers {
  const headers = new Headers();
  headers.set("Accept", "application/json");
  headers.set("Accept-Charset", "utf-8");
  headers.set("User-Agent", userAgent);
  headers.set("Cookie", getMemoizedCookieHeader(options.authToken));
  return headers;
}

function getHtmlHeaders(baseHeaders: Headers): Headers {
  const h = new Headers(baseHeaders);
  h.set(
    "Accept",
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  );
  return h;
}

function getRscHeaders(baseHeaders: Headers): Headers {
  const h = new Headers(baseHeaders);
  h.set("RSC", "1");
  h.set("Accept", "text/x-component");
  return h;
}

let actionIdsLoadPromise: Promise<void> | undefined;
const inFlightActionIdLookups = new Map<string, Promise<string>>();

async function ensureActionIdsLoaded(options: Options): Promise<void> {
  if (!options.downloadFolder) return;
  if (!actionIdsLoadPromise) {
    actionIdsLoadPromise = (async () => {
      try {
        const saved = await readJsonFile(
          options.downloadFolder,
          "actionIds.json",
        );
        if (saved && typeof saved === "object" && !Array.isArray(saved)) {
          for (
            const [k, v] of Object.entries(saved as Record<string, unknown>)
          ) {
            if (typeof v === "string" && v && !nextActionIdCache.has(k)) {
              nextActionIdCache.set(k, v);
            }
          }
        }
      } catch {
        // Ignore unreadable or missing actionIds.json
      }
    })();
  }
  await actionIdsLoadPromise;
}

async function persistActionIds(options: Options): Promise<void> {
  if (
    !options.downloadFolder || options.dryRun || nextActionIdCache.size === 0
  ) {
    return;
  }
  await writeJsonFile(
    options.downloadFolder,
    "actionIds.json",
    Object.fromEntries(nextActionIdCache.entries()),
  ).catch(() => {});
}

/**
 * Dynamically discovers a Next.js Server Action ID (`createServerReference`) from the page's client chunks.
 */
async function resolveNextActionId(
  actionName: string,
  pagePath: string,
  options: Options,
): Promise<string> {
  await ensureActionIdsLoaded(options);
  const cached = nextActionIdCache.get(actionName);
  if (cached) return cached;

  const routeKey = pagePath.startsWith("/home/library/")
    ? "/home/library/[id]"
    : pagePath;
  const lookupKey = `${routeKey}::${actionName}`;
  const inFlight = inFlightActionIdLookups.get(lookupKey);
  if (inFlight) return inFlight;

  const lookupPromise = (async () => {
    const escapedName = actionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const actionRe = new RegExp(
      `createServerReference\\)\\("([a-f0-9]+)"[^)]*?"${escapedName}"\\)`,
    );

    const scanChunks = async (
      paths: string[],
    ): Promise<string | undefined> => {
      const BATCH_SIZE = 6;
      for (let i = 0; i < paths.length; i += BATCH_SIZE) {
        const batch = paths.slice(i, i + BATCH_SIZE);
        const texts = await Promise.all(
          batch.map((chPath) => {
            let p = chunkTextCache.get(chPath);
            if (!p) {
              p = fetchWithRetry(`${BASE_URL}${chPath}`, {
                headers: { "User-Agent": userAgent },
              }).then((r) => (r.ok ? r.text() : "")).catch(() => "");
              chunkTextCache.set(chPath, p);
            }
            return p;
          }),
        );

        let discoveredNew = false;
        for (const js of texts) {
          for (
            const m of js.matchAll(
              /createServerReference\)\("([a-f0-9]+)"[^)]*?"([^"]+)"\)/g,
            )
          ) {
            if (nextActionIdCache.get(m[2]) !== m[1]) {
              nextActionIdCache.set(m[2], m[1]);
              discoveredNew = true;
            }
          }
          const match = js.match(actionRe);
          if (match?.[1]) {
            nextActionIdCache.set(actionName, match[1]);
            await persistActionIds(options);
            return match[1];
          }
        }
        if (discoveredNew) {
          await persistActionIds(options);
        }
      }
      return nextActionIdCache.get(actionName);
    };

    const scanned = new Set<string>();
    const initialPaths = knownChunkPathsByRoute.get(routeKey) ?? [];
    if (initialPaths.length > 0) {
      const found = await scanChunks(initialPaths);
      if (found) return found;
      for (const p of initialPaths) scanned.add(p);
    }

    // Fallback to fetching full HTML once if chunks weren't cached yet or came from a partial RSC Flight payload
    const pageResp = await fetchWithRetry(`${BASE_URL}${pagePath}`, {
      headers: getHtmlHeaders(getRequestHeaders(options)),
    });
    if (!pageResp.ok) {
      throw new Error(
        `Failed to load ${pagePath} to discover ${actionName}: HTTP ${pageResp.status}`,
      );
    }
    const html = await pageResp.text();
    const allPaths = registerChunkPaths(routeKey, html);
    const remainingPaths = allPaths.filter((p) => !scanned.has(p));
    if (remainingPaths.length > 0) {
      const found = await scanChunks(remainingPaths);
      if (found) return found;
    }

    throw new Error(
      `Could not locate Next.js Server Action "${actionName}" in ${pagePath} client bundles`,
    );
  })().finally(() => {
    inFlightActionIdLookups.delete(lookupKey);
  });

  inFlightActionIdLookups.set(lookupKey, lookupPromise);
  return lookupPromise;
}

/**
 * Invokes a Next.js Server Action on `pagePath`, automatically handling deployment skew (`HTTP 409`)
 * by re-discovering the fresh action ID once if needed.
 */
async function invokeNextServerAction<T = unknown>(
  actionName: string,
  pagePath: string,
  args: unknown[],
  options: Options,
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const actionId = await resolveNextActionId(actionName, pagePath, options);
    const headers = getRequestHeaders(options);
    headers.set("Accept", "text/x-component");
    headers.set("Content-Type", "text/plain;charset=UTF-8");
    headers.set("Next-Action", actionId);
    headers.set("Origin", BASE_URL);
    headers.set("Referer", `${BASE_URL}${pagePath}`);

    const resp = await fetchWithRetry(`${BASE_URL}${pagePath}`, {
      method: "POST",
      headers,
      body: JSON.stringify(args),
    });

    if (resp.status === 409 && attempt === 0) {
      await resp.body?.cancel().catch(() => {});
      nextActionIdCache.clear();
      chunkTextCache.clear();
      knownChunkPathsByRoute.clear();
      actionIdsLoadPromise = Promise.resolve();
      continue;
    }

    if (!resp.ok) {
      throw new Error(
        `Server Action ${actionName} failed: HTTP ${resp.status} ${resp.statusText}`,
      );
    }

    const bytes = new Uint8Array(await resp.arrayBuffer());
    const rows = parseRscStream(bytes);
    if (rows.has("1")) {
      return resolveFlightRefs(rows.get("1"), rows) as T;
    }
    for (const [id, val] of rows) {
      if (id !== "0" && val && typeof val === "object") {
        return resolveFlightRefs(val, rows) as T;
      }
    }
    throw new Error(`Empty response from Server Action ${actionName}`);
  }

  throw new Error(`Server Action ${actionName} failed after retry`);
}

interface RawDownloadStruct {
  id?: string;
  arch?: string | null;
  fileSize?: number | null;
  md5?: string | null;
  sha1?: string | null;
  name?: string | null;
  size?: string | null;
  timestamp?: number | null;
  small?: number | null;
  uploadedAt?: string | null;
  externalLink?: string | null;
  url?: {
    web?: string | null;
    bittorrent?: string | null;
  } | null;
}

interface RawPlatformDownload {
  id?: string;
  key?: string;
  desktopAppOnly?: boolean;
  downloadIdentifier?: string | null;
  downloadVersionNumber?: number | null;
  platform?: string;
  downloadStruct?: RawDownloadStruct[];
  updatedAt?: string | null;
  createdAt?: string | null;
}

interface RawDownloadEntitlement {
  id?: string;
  title?: string;
  type?: string | null;
  publisher?: string | null;
  icon?: string | null;
  customCtaLabel?: string | null;
  customCtaUrl?: string | null;
  downloads?: RawPlatformDownload[];
}

interface RawKeyEntitlement {
  id?: string;
  title?: string;
  redeemedAt?: string | null;
  expired?: boolean;
  redemptionData?: Record<string, unknown> | null;
}

interface RawLibraryItem {
  id: string;
  productEntitlementId?: string | null;
  title: string;
  subTitle?: string | null;
  itemType?: string | null;
  type?: string | null;
  deliveryMethods?: string[] | null;
  choiceDate?: string | null;
  releaseDate?: string | null;
  entitlements?: {
    keys?: RawKeyEntitlement[];
    downloads?: RawDownloadEntitlement[];
  };
}

/**
 * Returns true if `gameKey` is a UUID (or `group/<uuid>`) from Humble's migrated Next.js platform,
 * rather than a legacy 12–16 character Tornado order gamekey.
 */
export function isMigratedPlatformKey(gameKey: string): boolean {
  return /^(?:group\/)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    .test(gameKey.trim());
}

function encodeLibraryKeyPath(gameKey: string): string {
  if (gameKey.startsWith("group/")) {
    return `/home/library/group/${encodeURIComponent(gameKey.slice(6))}`;
  }
  return `/home/library/${encodeURIComponent(gameKey)}`;
}

interface RawUserLibraryProps {
  vaultItems?: RawLibraryItem[];
  bundleItems?: RawLibraryItem[];
}

function findObjectWithKeys(
  node: unknown,
  requiredKeys: string[],
): Record<string, unknown> | undefined {
  if (!node || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findObjectWithKeys(item, requiredKeys);
      if (found) return found;
    }
    return undefined;
  }
  const rec = node as Record<string, unknown>;
  if (requiredKeys.every((k) => k in rec)) return rec;
  for (const val of Object.values(rec)) {
    const found = findObjectWithKeys(val, requiredKeys);
    if (found) return found;
  }
  return undefined;
}

/**
 * Fetches `/home/library` and extracts `UserLibrary` props (`vaultItems` and `bundleItems`).
 * Verifies authentication if the library payload is absent.
 */
async function fetchUserLibraryProps(
  options: Options,
): Promise<RawUserLibraryProps> {
  const headers = getRscHeaders(getRequestHeaders(options));
  const response = await fetchWithRetry(`${BASE_URL}${LIBRARY_PATH}`, {
    headers,
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch Humble Library: HTTP ${response.status} ${response.statusText}. Please verify your cookie.txt / auth token.`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  let flightBytes: Uint8Array;
  if (contentType.includes("text/x-component")) {
    flightBytes = new Uint8Array(await response.arrayBuffer());
    if (!knownChunkPathsByRoute.has(LIBRARY_PATH)) {
      registerChunkPaths(LIBRARY_PATH, textDecoder.decode(flightBytes));
    }
  } else {
    const html = await response.text();
    registerChunkPaths(LIBRARY_PATH, html);
    flightBytes = extractFlightBytesFromHtml(html);
  }

  const rows = parseRscStream(flightBytes);
  for (const [, rowVal] of rows) {
    const found = findObjectWithKeys(rowVal, ["vaultItems", "bundleItems"]);
    if (found) {
      return resolveFlightRefs(found, rows) as RawUserLibraryProps;
    }
  }

  // Check session-status to produce a clear authentication error message
  const statusResp = await fetchWithRetry(
    `${BASE_URL}/api/auth/session-status`,
    { headers: getRequestHeaders(options) },
  ).catch(() => undefined);
  if (statusResp?.ok) {
    const statusJson = await statusResp.json().catch(() => ({}));
    if (statusJson?.status === "anonymous") {
      throw new Error(
        "Humble Bundle session is anonymous or expired. Please log in at https://www.humblebundle.com/home/library and export fresh cookies to cookie.txt.",
      );
    }
  }

  throw new Error(
    "Unable to locate UserLibrary data on /home/library. Your session cookies may have expired.",
  );
}

function slugifyMachineName(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "item";
}

function inferPublisherFromBundleTitle(
  bundleTitle: string,
): string | undefined {
  const byMatch = bundleTitle.match(/\s+by\s+([^()[\]]+)$/i);
  return byMatch?.[1]?.trim() || undefined;
}

/**
 * Maps a Next.js `userLibraryItem` from `/home/library/<id>` into the canonical `Bundle` structure.
 */
export function convertLibraryItemToBundle(
  gameKey: string,
  item: RawLibraryItem,
): Bundle {
  const inferredPublisher = inferPublisherFromBundleTitle(item.title);
  const subproducts: SubProduct[] = [];
  let earliestCreatedMs = Infinity;

  for (const ent of item.entitlements?.downloads ?? []) {
    const rawDownloads = ent.downloads ?? [];
    const firstKey = rawDownloads[0]?.key ?? "";
    const derivedSubProductMachine = firstKey
      ? firstKey.replace(
        /_(ebook|audio|video|windows|win|mac|osx|linux|android|asmjs|comedy|other)$/i,
        "",
      )
      : slugifyMachineName(ent.title ?? ent.id ?? "item");

    const mappedDownloads: BundleDownload[] = [];
    for (const dl of rawDownloads) {
      for (const ts of [dl.createdAt, dl.updatedAt]) {
        if (ts) {
          const ms = Date.parse(ts);
          if (!isNaN(ms) && ms < earliestCreatedMs) earliestCreatedMs = ms;
        }
      }

      const mappedStructs: DownloadStruct[] = (dl.downloadStruct ?? []).map(
        (st) => ({
          sha1: st.sha1 ?? undefined,
          md5: st.md5 ?? undefined,
          name: st.name ?? undefined,
          human_size: st.size ?? "",
          file_size: st.fileSize ?? undefined,
          small: st.small ?? undefined,
          timestamp: st.timestamp ?? undefined,
          uploaded_at: st.uploadedAt ?? undefined,
          external_link: st.externalLink ??
            (!st.url?.web && ent.customCtaUrl ? ent.customCtaUrl : undefined),
          arch: st.arch ?? undefined,
          url: st.url?.web
            ? {
              web: st.url.web,
              ...(st.url.bittorrent ? { bittorrent: st.url.bittorrent } : {}),
            }
            : undefined,
        }),
      );

      // Surface external-link-only items when downloadStruct is empty
      if (mappedStructs.length === 0 && ent.customCtaUrl) {
        mappedStructs.push({
          name: ent.customCtaLabel || "External Link",
          human_size: "",
          external_link: ent.customCtaUrl,
        });
      }

      mappedDownloads.push({
        desktop_app_only: Boolean(dl.desktopAppOnly),
        machine_name: dl.key ?? derivedSubProductMachine,
        download_struct: mappedStructs,
        options_dict: null,
        download_identifier: dl.downloadIdentifier ?? null,
        platform: (dl.platform?.toLowerCase() ?? Platform.Other) as Platform,
        download_version_number: dl.downloadVersionNumber ?? null,
      });
    }

    const pubName = ent.publisher || inferredPublisher || "";
    subproducts.push({
      entitlement_id: ent.id,
      machine_name: derivedSubProductMachine,
      url: "",
      downloads: mappedDownloads,
      library_family_name: null,
      payee: {
        human_name: pubName,
        machine_name: pubName ? slugifyMachineName(pubName) : "",
      },
      human_name: ent.title ?? derivedSubProductMachine,
      custom_download_page_box_css: null,
      custom_download_page_box_html: null,
      icon: ent.icon ?? null,
    });
  }

  const unredeemedKeyItems: { human_name: string }[] = [];
  for (const k of item.entitlements?.keys ?? []) {
    const rec = k.redemptionData ?? {};
    const hasKeyVal = Boolean(
      k.redeemedAt || rec.keyValue || rec.keyFormatted || rec.redeemed_key_val,
    );
    if (!hasKeyVal && !k.expired && k.title) {
      unredeemedKeyItems.push({ human_name: k.title });
    }
  }

  const createdIso = item.choiceDate ||
    item.releaseDate ||
    (Number.isFinite(earliestCreatedMs)
      ? new Date(earliestCreatedMs).toISOString()
      : new Date(0).toISOString());

  return {
    amount_spent: 0,
    product: {
      category: item.type === "subscriptioncontent" ||
          item.itemType === "entitlement-group"
        ? Category.Subscriptioncontent
        : Category.Bundle,
      machine_name: slugifyMachineName(item.title),
      empty_tpkds: unredeemedKeyItems as unknown as { [key: string]: string[] },
      post_purchase_text: "",
      human_name: item.title,
      partial_gift_enabled: false,
    },
    gamekey: gameKey,
    uid: item.id,
    created: createdIso,
    missed_credit: null,
    subproducts,
    total_choices: 0,
    choices_remaining: 0,
    currency: null,
    is_giftee: false,
    claimed: true,
    total: 0,
    path_ids: [],
  };
}

/**
 * Fetches order details for an individual bundle (`productEntitlementId` on `/home/library/<id>`
 * or `group/<id>` on `/home/library/group/<id>`).
 * Supports JSON responses as fallback for unit tests.
 *
 * @param baseUrl Base Humble Bundle URL
 * @param gameKey Bundle productEntitlementId, `group/<id>`, or legacy gamekey
 * @param headers HTTP headers with auth session
 * @returns Bundle order details
 */
export async function fetchBundleDetails(
  baseUrl: string,
  gameKey: string,
  headers: Headers,
): Promise<Bundle> {
  const itemPath = encodeLibraryKeyPath(gameKey);
  const maxParseAttempts = 4;

  for (let attempt = 1; attempt <= maxParseAttempts; attempt++) {
    const reqHeaders = attempt < maxParseAttempts
      ? getRscHeaders(headers)
      : getHtmlHeaders(headers);
    const response = await fetchWithRetry(
      `${baseUrl}${itemPath}`,
      { headers: reqHeaders },
    );
    if (!response.ok) {
      throw new Error(
        `Failed to fetch bundle details for ${gameKey}: HTTP ${response.status} ${response.statusText}`,
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return await response.json();
    }

    // Fail fast without sleeping if redirected to /login (unauthenticated or expired session)
    const nextRedirect = response.headers.get("x-nextjs-redirect") ?? "";
    if (
      (response.url && /\/login\b/i.test(response.url)) ||
      /\/login\b/i.test(nextRedirect)
    ) {
      await response.body?.cancel().catch(() => {});
      throw new Error(
        `Session redirected to login while fetching ${itemPath}`,
      );
    }

    let flightBytes: Uint8Array;
    if (contentType.includes("text/x-component")) {
      flightBytes = new Uint8Array(await response.arrayBuffer());
      if (!knownChunkPathsByRoute.has("/home/library/[id]")) {
        registerChunkPaths(
          "/home/library/[id]",
          textDecoder.decode(flightBytes),
        );
      }
    } else {
      const html = await response.text();
      registerChunkPaths("/home/library/[id]", html);
      flightBytes = extractFlightBytesFromHtml(html);
    }

    const rows = parseRscStream(flightBytes);
    for (const [, rowVal] of rows) {
      const found = findObjectWithKeys(rowVal, ["userLibraryItem"]);
      if (found?.userLibraryItem) {
        const resolvedItem = resolveFlightRefs(
          found.userLibraryItem,
          rows,
        ) as RawLibraryItem;
        return convertLibraryItemToBundle(gameKey, resolvedItem);
      }
    }

    if (attempt < maxParseAttempts) {
      await delay(600 * Math.pow(2, attempt - 1));
    }
  }

  throw new Error(
    `Could not parse bundle details for ${gameKey} from ${itemPath}`,
  );
}

interface SignedUrlActionResult {
  ok: boolean;
  code?: string;
  data?: {
    signedUrls: Record<string, Record<string, Record<string, string>>>;
    expiresAt?: string;
  };
}

// Micro-batch queue for signing multiple bundle entitlements in a single Server Action call
interface PendingEntitlementBatch {
  gameKey: string;
  options: Options;
  items: Map<
    string,
    {
      resolve: (val: CachedSignedMap) => void;
      reject: (err: unknown) => void;
    }[]
  >;
  timer: ReturnType<typeof setTimeout>;
}
const pendingEntitlementBatches = new Map<string, PendingEntitlementBatch>();

function fetchEntitlementSignedMap(
  entitlementId: string,
  gameKey: string,
  options: Options,
  forceRefresh = false,
): Promise<CachedSignedMap> {
  if (forceRefresh) {
    entitlementSignedUrlsCache.delete(entitlementId);
  } else {
    const existing = entitlementSignedUrlsCache.get(entitlementId);
    if (existing) {
      return existing.then((cached) => {
        if (cached.expiresAtMs > Date.now() + 5 * 60_000) {
          return cached;
        }
        entitlementSignedUrlsCache.delete(entitlementId);
        return fetchEntitlementSignedMap(entitlementId, gameKey, options, true);
      });
    }
  }

  const promise = new Promise<CachedSignedMap>(
    (resolvePromise, rejectPromise) => {
      let batch = pendingEntitlementBatches.get(gameKey);
      const flushBatch = (b: PendingEntitlementBatch) => {
        pendingEntitlementBatches.delete(gameKey);
        const ids = [...b.items.keys()];
        const pagePath = encodeLibraryKeyPath(b.gameKey);
        invokeNextServerAction<SignedUrlActionResult>(
          "getSignedUrlsForEntitlements",
          pagePath,
          [ids],
          b.options,
        )
          .then((res) => {
            if (!res?.ok || !res.data?.signedUrls) {
              throw new Error(
                `Unable to sign bundle download URLs (${
                  res?.code ?? "unknown error"
                })`,
              );
            }
            const expiresAtMs = res.data.expiresAt
              ? Date.parse(res.data.expiresAt)
              : Date.now() + 3600_000;
            const sharedMap: CachedSignedMap = {
              signedUrls: res.data.signedUrls,
              expiresAtMs: isNaN(expiresAtMs)
                ? Date.now() + 3600_000
                : expiresAtMs,
            };
            for (const callbacks of b.items.values()) {
              for (const cb of callbacks) cb.resolve(sharedMap);
            }
          })
          .catch((err) => {
            for (const id of ids) entitlementSignedUrlsCache.delete(id);
            for (const callbacks of b.items.values()) {
              for (const cb of callbacks) cb.reject(err);
            }
          });
      };

      if (!batch) {
        batch = {
          gameKey,
          options,
          items: new Map(),
          timer: setTimeout(() => flushBatch(batch!), 15),
        };
        pendingEntitlementBatches.set(gameKey, batch);
      }

      const list = batch.items.get(entitlementId) ?? [];
      list.push({ resolve: resolvePromise, reject: rejectPromise });
      batch.items.set(entitlementId, list);

      if (batch.items.size >= 25) {
        clearTimeout(batch.timer);
        flushBatch(batch);
      }
    },
  );

  entitlementSignedUrlsCache.set(entitlementId, promise);
  return promise;
}

function lookupSignedUrlInMap(
  signedUrls: Record<string, Record<string, Record<string, string>>>,
  subproductMachineName: string,
  downloadKey: string | undefined,
  relFilename: string,
): string | undefined {
  const encodedRel = encodeRfc3986Path(relFilename);
  const candidates = [encodedRel, relFilename];

  const tryDownloadGroup = (
    dlGroup: Record<string, Record<string, string>> | undefined,
  ): string | undefined => {
    if (!dlGroup) return undefined;
    if (downloadKey && dlGroup[downloadKey]) {
      for (const c of candidates) {
        if (dlGroup[downloadKey][c]) return dlGroup[downloadKey][c];
      }
    }
    for (const files of Object.values(dlGroup)) {
      for (const c of candidates) {
        if (files?.[c]) return files[c];
      }
    }
    return undefined;
  };

  // 1. Direct match on subproductMachineName
  const direct = tryDownloadGroup(signedUrls[subproductMachineName]);
  if (direct) return direct;

  // 2. Fallback scan across returned subproducts in the batch
  for (const dlGroup of Object.values(signedUrls)) {
    const found = tryDownloadGroup(dlGroup);
    if (found) return found;
  }
  return undefined;
}

/**
 * Signs or refreshes a bundle item's download URL via `getSignedUrlsForEntitlements`,
 * falling back to re-querying bundle details when needed.
 *
 * @param download Target download item
 * @param options Runtime options containing authToken
 * @param forceRefresh Bypass any cached signed URL
 * @returns Fresh signed URL
 */
export async function refreshDownloadUrl(
  download: DownloadInfo,
  options: Options,
  forceRefresh = false,
): Promise<URL> {
  const relFile = download.webFilename ?? download.fileName;

  if (download.entitlementId) {
    const cachedMap = await fetchEntitlementSignedMap(
      download.entitlementId,
      download.gameKey,
      options,
      forceRefresh,
    );
    const signed = lookupSignedUrlInMap(
      cachedMap.signedUrls,
      download.machineName,
      download.downloadKey,
      relFile,
    );
    if (signed) {
      return new URL(signed);
    }
  }

  let bundlePromise = refreshedBundlesCache.get(download.gameKey);
  if (!bundlePromise || forceRefresh) {
    bundlePromise = fetchBundleDetails(
      BASE_URL,
      download.gameKey,
      getRequestHeaders(options),
    ).catch((err) => {
      refreshedBundlesCache.delete(download.gameKey);
      if (
        !isMigratedPlatformKey(download.gameKey) &&
        err instanceof Error &&
        err.message.includes("HTTP 404")
      ) {
        throw new Error(
          `Legacy bundle "${download.bundle}" (${download.gameKey}) has not been migrated to Humble's new library yet`,
        );
      }
      throw err;
    });
    refreshedBundlesCache.set(download.gameKey, bundlePromise);
  }

  const bundleDetails: Bundle = await bundlePromise;

  let fallbackUrl: URL | undefined;
  for (const subProduct of bundleDetails.subproducts) {
    if (subProduct.machine_name === download.machineName) {
      if (subProduct.entitlement_id) {
        const cachedMap = await fetchEntitlementSignedMap(
          subProduct.entitlement_id,
          download.gameKey,
          options,
          forceRefresh,
        );
        const signed = lookupSignedUrlInMap(
          cachedMap.signedUrls,
          subProduct.machine_name,
          download.downloadKey,
          relFile,
        );
        if (signed) return new URL(signed);
      }

      for (const dl of subProduct.downloads) {
        for (const struct of dl.download_struct) {
          if (!struct.url) continue;
          const targetUrlStr = options.torrent && struct.url.bittorrent
            ? struct.url.bittorrent
            : struct.url.web;
          if (!/^https?:\/\//i.test(targetUrlStr)) continue;
          const parsedUrl = new URL(targetUrlStr);
          const urlBase = decodeURIComponent(basename(parsedUrl.pathname));
          if (urlBase === download.fileName) {
            return parsedUrl;
          }
          if ((struct.name ?? download.fileName) === download.structName) {
            fallbackUrl = parsedUrl;
          }
        }
      }
    }
  }
  if (fallbackUrl) return fallbackUrl;
  throw new Error(`Could not find updated URL for ${download.fileName}`);
}

interface FilterUserLibraryResponse {
  results?: RawLibraryItem[];
  pagination?: {
    page: number;
    totalPages: number;
    totalDocs: number;
  };
  success?: boolean;
  error?: string;
}

const FILTER_LIBRARY_PAGE_LIMIT = 2000;

async function fetchFilteredLibraryPage(
  page: number,
  options: Options,
): Promise<FilterUserLibraryResponse> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const actionId = await resolveNextActionId(
      "filterUserLibrary",
      LIBRARY_PATH,
      options,
    );
    const fd = new FormData();
    fd.append("_1_requestId", String(page));
    fd.append("_1_query", "");
    fd.append("_1_sort", "mostRecent");
    fd.append("_1_cursor", String(FILTER_LIBRARY_PAGE_LIMIT * page));
    fd.append("_1_page", String(page));
    fd.append("_1_limit", String(FILTER_LIBRARY_PAGE_LIMIT));
    fd.append("_1_hideRevealed", "false");
    fd.append("_1_hideExpired", "false");
    fd.append("_1_dateExpires", "");
    // Field "0" MUST be appended after `_1_*` fields so streaming busboy decoding populates `$K1` first
    fd.append(
      "0",
      JSON.stringify([
        {
          results: [],
          pagination: { page: 1, totalPages: 1, totalDocs: 0 },
          success: true,
        },
        "$K1",
      ]),
    );

    const headers = getRequestHeaders(options);
    headers.set("Accept", "text/x-component");
    headers.set("Next-Action", actionId);
    headers.set("Origin", BASE_URL);
    headers.set("Referer", `${BASE_URL}${LIBRARY_PATH}`);

    const resp = await fetchWithRetry(`${BASE_URL}${LIBRARY_PATH}`, {
      method: "POST",
      headers,
      body: fd,
    });

    if (resp.status === 409 && attempt === 0) {
      await resp.body?.cancel().catch(() => {});
      nextActionIdCache.clear();
      chunkTextCache.clear();
      knownChunkPathsByRoute.clear();
      actionIdsLoadPromise = Promise.resolve();
      continue;
    }

    if (!resp.ok) {
      throw new Error(
        `filterUserLibrary failed on page ${page}: HTTP ${resp.status} ${resp.statusText}`,
      );
    }

    const bytes = new Uint8Array(await resp.arrayBuffer());
    const rows = parseRscStream(bytes);
    for (const id of ["1", "0", "2"]) {
      if (rows.has(id)) {
        const val = resolveFlightRefs(rows.get(id), rows) as
          | FilterUserLibraryResponse
          | undefined;
        if (val && typeof val === "object" && "pagination" in val) {
          return val;
        }
      }
    }
    return { results: [], pagination: { page, totalPages: 1, totalDocs: 0 } };
  }
  return { results: [], pagination: { page, totalPages: 1, totalDocs: 0 } };
}

/**
 * Queries Humble's paginated `filterUserLibrary` Server Action across all pages (`limit = 2000`)
 * to discover older migrated bundles (`productEntitlementId`) and Choice groups (`entitlement-group`)
 * beyond the ~200-item cap on `/home/library`'s SSR `bundleItems` prop.
 */
async function fetchAllLibraryItems(
  options: Options,
): Promise<RawLibraryItem[]> {
  const firstPage = await fetchFilteredLibraryPage(1, options);
  if (!firstPage.success || !firstPage.results) {
    return [];
  }
  const totalPages = firstPage.pagination?.totalPages ?? 1;
  if (totalPages <= 1) {
    return firstPage.results;
  }

  const allItems: RawLibraryItem[] = [...firstPage.results];
  const CONCURRENCY = 5;
  for (let p = 2; p <= totalPages; p += CONCURRENCY) {
    const batch: Promise<FilterUserLibraryResponse>[] = [];
    for (let j = p; j < p + CONCURRENCY && j <= totalPages; j++) {
      batch.push(fetchFilteredLibraryPage(j, options));
    }
    const responses = await Promise.all(batch);
    for (const r of responses) {
      if (r.results) allItems.push(...r.results);
    }
  }
  return allItems;
}

/**
 * Retains legacy (non-UUID) `Bundle` entries from a pre-migration `bundles.json` / `bundles.legacy.json`
 * when those bundles have not yet been migrated to Humble's new library (e.g. 2010–2013 orders),
 * preventing `clean()` from deleting already-downloaded files while avoiding duplicates for migrated bundles.
 */
export function mergeUnmigratedLegacyBundles(
  liveBundles: Bundle[],
  legacyCandidates: Bundle[],
  allLiveTitlesLower: ReadonlySet<string>,
): Bundle[] {
  if (legacyCandidates.length === 0) return [];

  const liveSubproductNames = new Set<string>();
  for (const lb of liveBundles) {
    for (const sp of lb.subproducts) {
      if (sp.downloads.length > 0 && sp.machine_name) {
        liveSubproductNames.add(sp.machine_name.toLowerCase());
      }
    }
  }

  const retained: Bundle[] = [];
  const seenGameKeys = new Set<string>();

  for (const legacy of legacyCandidates) {
    if (!legacy?.gamekey || isMigratedPlatformKey(legacy.gamekey)) continue;
    if (seenGameKeys.has(legacy.gamekey)) continue;
    seenGameKeys.add(legacy.gamekey);

    const titleLower = legacy.product?.human_name?.trim().toLowerCase() ?? "";
    if (titleLower && allLiveTitlesLower.has(titleLower)) {
      continue;
    }

    const dlSubproducts = (legacy.subproducts ?? []).filter(
      (sp) => sp.downloads && sp.downloads.length > 0 && sp.machine_name,
    );
    if (
      dlSubproducts.length >= 2 &&
      dlSubproducts.every((sp) =>
        liveSubproductNames.has(sp.machine_name.toLowerCase())
      )
    ) {
      continue;
    }

    retained.push(legacy);
  }

  return retained;
}

/**
 * Enriches migrated Next.js `Bundle` entries with historical metadata (`icon`, `payee`, `url`, and `created` date)
 * from pre-migration `bundles.legacy.json` / `bundles.json` when Humble's migrated endpoint omits them.
 */
function enrichMigratedBundlesFromLegacy(
  liveBundles: Bundle[],
  legacyCandidates: Bundle[],
): void {
  if (liveBundles.length === 0 || legacyCandidates.length === 0) return;

  const legacySubByMachine = new Map<string, SubProduct>();
  const legacyBundleByTitle = new Map<string, Bundle>();

  for (const lb of legacyCandidates) {
    const titleKey = lb.product?.human_name?.trim().toLowerCase();
    if (titleKey) {
      const prev = legacyBundleByTitle.get(titleKey);
      if (
        !prev ||
        (lb.created &&
          (!prev.created ||
            Date.parse(lb.created) > Date.parse(prev.created)))
      ) {
        legacyBundleByTitle.set(titleKey, lb);
      }
    }
    for (const sp of lb.subproducts ?? []) {
      const keys = new Set<string>();
      if (sp.machine_name) keys.add(sp.machine_name.toLowerCase());
      for (const dl of sp.downloads ?? []) {
        if (dl.machine_name) {
          keys.add(
            dl.machine_name
              .replace(
                /_(ebook|audio|video|windows|win|mac|osx|linux|android|asmjs|comedy|other)$/i,
                "",
              )
              .toLowerCase(),
          );
        }
      }
      for (const k of keys) {
        if (!legacySubByMachine.has(k)) {
          legacySubByMachine.set(k, sp);
        }
      }
    }
  }

  for (const bundle of liveBundles) {
    const titleKey = bundle.product?.human_name?.trim().toLowerCase();
    const matchedBundle = titleKey
      ? legacyBundleByTitle.get(titleKey)
      : undefined;
    if (
      matchedBundle?.created &&
      (!bundle.created ||
        bundle.created === "1970-01-01T00:00:00.000Z" ||
        Date.parse(matchedBundle.created) < Date.parse(bundle.created))
    ) {
      bundle.created = matchedBundle.created;
    }

    for (const sp of bundle.subproducts) {
      const legacySp = legacySubByMachine.get(sp.machine_name.toLowerCase());
      if (!legacySp) continue;
      if (!sp.icon && legacySp.icon) sp.icon = legacySp.icon;
      if (!sp.url && legacySp.url) sp.url = legacySp.url;
      if (!sp.payee?.human_name && legacySp.payee?.human_name) {
        sp.payee = legacySp.payee;
      }
    }
  }
}

const OFFLINE_CACHEABLE_COMMANDS = new Set<string>([
  COMMANDS.bundles,
  COMMANDS.unclaimed,
  COMMANDS.stats,
  COMMANDS.list,
  COMMANDS.export,
  COMMANDS.verify,
  COMMANDS.cleanup,
  COMMANDS.cleanupAudio,
  COMMANDS.cleanupEbooks,
  COMMANDS.cleanupTrove,
  COMMANDS.cleanupVideos,
]);

/**
 * Fetches all purchased bundles from the Humble Bundle account (`/home/library` + `filterUserLibrary`).
 * Uses local `bundles.json` cache when available unless `--update` is specified, and preserves
 * unmigrated legacy bundles from `bundles.json` / `bundles.legacy.json` until Humble migrates them.
 */
export async function getAllBundles(
  options: Options,
  totals: Totals,
  queues: Queues,
  progress: MultiBarWrapper,
): Promise<Bundle[]> {
  const diskMain = await readJsonFile<Bundle[]>(
    options.downloadFolder,
    "bundles.json",
  );
  const existingDiskBundles: Bundle[] = Array.isArray(diskMain) ? diskMain : [];

  const diskLegacy = await readJsonFile<Bundle[]>(
    options.downloadFolder,
    "bundles.legacy.json",
  );
  const existingLegacyArchive: Bundle[] = Array.isArray(diskLegacy)
    ? diskLegacy
    : [];

  // Pool of any legacy non-UUID bundles from either `bundles.legacy.json` or `bundles.json`
  const legacyPoolMap = new Map<string, Bundle>();
  for (const b of existingLegacyArchive) {
    if (b?.gamekey && !isMigratedPlatformKey(b.gamekey)) {
      legacyPoolMap.set(b.gamekey, b);
    }
  }
  let diskMainHadLegacy = false;
  for (const b of existingDiskBundles) {
    if (b?.gamekey && !isMigratedPlatformKey(b.gamekey)) {
      diskMainHadLegacy = true;
      if (!legacyPoolMap.has(b.gamekey)) {
        legacyPoolMap.set(b.gamekey, b);
      }
    }
  }
  const legacyPool = [...legacyPoolMap.values()];

  function sortBundlesByCreatedDesc(bundles: Bundle[]): Bundle[] {
    const times = new Map<Bundle, number>();
    for (const b of bundles) {
      times.set(b, Date.parse(b.created) || 0);
    }
    return bundles.sort((a, b) => (times.get(b) ?? 0) - (times.get(a) ?? 0));
  }

  const cachedBundles: Bundle[] = options.forceUpdate
    ? []
    : existingDiskBundles.filter((b) => isMigratedPlatformKey(b.gamekey));

  const cmd = options.command?.toLowerCase() ?? COMMANDS.ebooks;
  if (
    !options.update &&
    !options.forceUpdate &&
    existingDiskBundles.length > 0 &&
    (!options.authToken || OFFLINE_CACHEABLE_COMMANDS.has(cmd))
  ) {
    totals.bundles = existingDiskBundles.length;
    progressDebug(
      progress,
      `Using ${existingDiskBundles.length} cached bundles from bundles.json`,
    );
    return sortBundlesByCreatedDesc(existingDiskBundles);
  }

  const targetBundleKeys = parseBundleKeys(options.bundleKey);
  const rawRequestedKeys = (options.bundleKey ?? [])
    .flatMap((entry) => entry.split(","))
    .map((part) => {
      const trimmed = part.trim();
      const match = trimmed.match(/\/home\/library\/((?:group\/)?[^/?#]+)/i);
      return (match?.[1] ?? trimmed).trim();
    })
    .filter(Boolean);
  const allTargetsAreExplicitUuids = rawRequestedKeys.length > 0 &&
    rawRequestedKeys.every((k) => isMigratedPlatformKey(k));

  const allLiveBundleIds = new Set<string>();
  const downloadableBundleIds = new Set<string>();
  const allLiveTitlesLower = new Set<string>();
  const liveTitleById = new Map<string, string>();

  if (allTargetsAreExplicitUuids) {
    for (const k of rawRequestedKeys) {
      allLiveBundleIds.add(k);
      downloadableBundleIds.add(k);
    }
  } else {
    let allItems: RawLibraryItem[] = [];
    try {
      progressDebug(
        progress,
        "Scanning full Humble library via filterUserLibrary...",
      );
      allItems = await fetchAllLibraryItems(options);
    } catch {
      allItems = [];
    }

    if (allItems.length > 0) {
      for (const item of allItems) {
        const id = item.itemType === "entitlement-group"
          ? `group/${item.id}`
          : item.productEntitlementId;
        if (!id) continue;
        allLiveBundleIds.add(id);
        const bundleTitle = item.subTitle || item.title;
        if (bundleTitle) {
          const lower = bundleTitle.trim().toLowerCase();
          allLiveTitlesLower.add(lower);
          liveTitleById.set(id, lower);
        }
        if (
          item.type === "download_drm_free" ||
          item.deliveryMethods?.includes("download") ||
          (item.entitlements?.downloads?.length ?? 0) > 0
        ) {
          downloadableBundleIds.add(id);
        }
      }
    } else {
      // Fallback to /home/library RSC payload if filterUserLibrary returned nothing
      let libProps: RawUserLibraryProps;
      try {
        libProps = await fetchUserLibraryProps(options);
      } catch (err) {
        if (existingDiskBundles.length > 0 && !options.update) {
          progressDebug(
            progress,
            `Network error fetching library (${
              err instanceof Error ? err.message : String(err)
            }); falling back to cached bundles.json`,
          );
          totals.bundles = existingDiskBundles.length;
          return existingDiskBundles.sort(
            (a, b) =>
              new Date(b.created).valueOf() - new Date(a.created).valueOf(),
          );
        }
        throw err;
      }

      for (const b of libProps.bundleItems ?? []) {
        const id = b.productEntitlementId ?? b.id;
        if (!id) continue;
        allLiveBundleIds.add(id);
        if (b.title) {
          const lower = b.title.trim().toLowerCase();
          allLiveTitlesLower.add(lower);
          liveTitleById.set(id, lower);
        }
        if ((b.entitlements?.downloads?.length ?? 0) > 0) {
          downloadableBundleIds.add(id);
        }
      }
    }
  }

  // Archive pre-migration legacy bundles to `bundles.legacy.json` before `bundles.json` transitions to UUIDs
  if (
    !options.dryRun &&
    diskMainHadLegacy &&
    legacyPool.length > existingLegacyArchive.length
  ) {
    await writeJsonFile(
      options.downloadFolder,
      "bundles.legacy.json",
      legacyPool,
    );
  }

  const needsKeyOnlyBundles = cmd === COMMANDS.bundles ||
    cmd === COMMANDS.unclaimed;
  const cachedKeys = new Set(cachedBundles.map((b) => b.gamekey));

  const idsToFetch = [...allLiveBundleIds].filter((id) => {
    if (cachedKeys.has(id)) return false;
    if (targetBundleKeys && !targetBundleKeys.has(id.toLowerCase())) {
      return false;
    }
    if (!needsKeyOnlyBundles && !downloadableBundleIds.has(id)) {
      return false;
    }
    return true;
  });

  const liveBundles: Bundle[] = cachedBundles.filter(
    (b) =>
      allLiveBundleIds.has(b.gamekey) &&
      (!targetBundleKeys || targetBundleKeys.has(b.gamekey.toLowerCase())),
  );

  if (idsToFetch.length > 0) {
    const headers = getRequestHeaders(options);
    const progressBar: SingleBarWrapper = progress.create(
      idsToFetch.length,
      0,
      {
        file: "Bundles",
      },
    );
    let newlyFetchedSinceCheckpoint = 0;
    let bundlesFlushInFlight = false;

    for (const bundleId of idsToFetch) {
      queues.orderInfo.add(async () => {
        try {
          const bundleDetails = await fetchBundleDetails(
            BASE_URL,
            bundleId,
            headers,
          );
          liveBundles.push(bundleDetails);
          newlyFetchedSinceCheckpoint++;
          if (
            !options.dryRun &&
            !targetBundleKeys &&
            newlyFetchedSinceCheckpoint >= 40 &&
            !bundlesFlushInFlight
          ) {
            newlyFetchedSinceCheckpoint = 0;
            bundlesFlushInFlight = true;
            const snapshot = [...liveBundles, ...legacyPool];
            writeJsonFile(
              options.downloadFolder,
              "bundles.json",
              snapshot,
            )
              .catch(() => {})
              .finally(() => {
                bundlesFlushInFlight = false;
              });
          }
        } catch (err) {
          const failedTitle = liveTitleById.get(bundleId);
          if (failedTitle) {
            // Allow legacyPool fallback for this run so clean() protects any local files from this bundle
            allLiveTitlesLower.delete(failedTitle);
          }
          progress.log(
            `Warning: Skipping bundle ${bundleId}${
              failedTitle ? ` ("${failedTitle}")` : ""
            } after retries: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        } finally {
          progressBar.increment();
        }
      });
    }

    await queues.orderInfo.done();
    progressBar.stop();
    progress.remove(progressBar);
  }

  enrichMigratedBundlesFromLegacy(liveBundles, legacyPool);

  const allRetainedLegacy = allTargetsAreExplicitUuids
    ? []
    : mergeUnmigratedLegacyBundles(
      liveBundles,
      legacyPool,
      allLiveTitlesLower,
    );
  const filteredLegacy = targetBundleKeys
    ? allRetainedLegacy.filter((b) =>
      targetBundleKeys.has(b.gamekey.toLowerCase())
    )
    : allRetainedLegacy;

  if (filteredLegacy.length > 0 && !targetBundleKeys) {
    progress.log(
      `Preserved ${filteredLegacy.length} unmigrated legacy bundle(s) from local cache alongside ${allLiveBundleIds.size} migrated Humble library bundles`,
    );
  }

  totals.bundles = targetBundleKeys
    ? liveBundles.length + filteredLegacy.length
    : allLiveBundleIds.size + filteredLegacy.length;

  const combinedBundles = [...liveBundles, ...filteredLegacy];

  if (!options.dryRun && (idsToFetch.length > 0 || diskMainHadLegacy)) {
    if (targetBundleKeys) {
      const mergedMap = new Map<string, Bundle>();
      for (const b of existingDiskBundles) {
        if (isMigratedPlatformKey(b.gamekey)) mergedMap.set(b.gamekey, b);
      }
      for (const b of liveBundles) mergedMap.set(b.gamekey, b);
      for (const b of legacyPool) mergedMap.set(b.gamekey, b);
      await writeJsonFile(
        options.downloadFolder,
        "bundles.json",
        [...mergedMap.values()],
      );
    } else {
      await writeJsonFile(
        options.downloadFolder,
        "bundles.json",
        combinedBundles,
      );
    }
  }

  return sortBundlesByCreatedDesc(combinedBundles);
}

/**
 * Converts Next.js `vaultItems` from `/home/library` into the `Trove[]` structure.
 */
export function convertVaultItemsToTroves(
  vaultItems: RawLibraryItem[],
): Trove[] {
  const troves: Trove[] = [];

  for (const item of vaultItems) {
    const cleanTitle = item.title
      .replace(/\s*\(subscriber_vault\)\s*$/i, "")
      .trim();

    for (const ent of item.entitlements?.downloads ?? []) {
      const subProductId = ent.id ?? slugifyMachineName(cleanTitle);
      const downloadsMap: Record<string, TroveDownload> = {};
      let dateAddedSec = 0;

      for (const dl of ent.downloads ?? []) {
        const platform = dl.platform?.toLowerCase();
        const st = dl.downloadStruct?.[0];
        if (!platform || !st?.url?.web) continue;

        const tsIso = st.uploadedAt ?? dl.updatedAt ?? dl.createdAt;
        const tsSec = tsIso ? Math.floor(Date.parse(tsIso) / 1000) : 0;
        if (
          !isNaN(tsSec) && tsSec > 0 &&
          (dateAddedSec === 0 || tsSec < dateAddedSec)
        ) {
          dateAddedSec = tsSec;
        }

        downloadsMap[platform] = {
          uploaded_at: !isNaN(tsSec) ? tsSec : 0,
          name: st.name ?? "ZIP",
          url: {
            web: st.url.web,
            bittorrent: st.url.bittorrent ?? "",
          },
          timestamp: st.timestamp ?? (!isNaN(tsSec) ? tsSec : 0),
          machine_name: dl.key ?? `${subProductId}_${platform}`,
          file_size: st.fileSize ?? 0,
          small: st.small ?? 0,
          size: st.size ?? "",
          md5: st.md5 ?? "",
          sha1: st.sha1 ?? undefined,
        };
      }

      if (Object.keys(downloadsMap).length > 0) {
        troves.push({
          subProductId,
          machine_name: `${subProductId}_trove`,
          "hero-marketing-blurb": null,
          "hero-background-image": null,
          image: ent.icon ?? "",
          "human-name": cleanTitle,
          logo: null,
          "all-access": false,
          "trove-showcase-css": null,
          "youtube-link": null,
          "humble-original": true,
          developers: [],
          "background-color": null,
          "marketing-blurb": "",
          publishers: ent.publisher
            ? [{ "publisher-name": ent.publisher }]
            : null,
          downloads: downloadsMap as Trove["downloads"],
          "description-text": "",
          "date-added": dateAddedSec,
          "background-image": null,
          popularity: 0,
          "hero-character-image": null,
          "hero-game-logo": null,
          "carousel-content": { thumbnail: [], screenshot: [] },
          "date-ended": 0,
          trove_category: "general",
          "is-client-hero": null,
        });
      }
    }
  }

  return troves;
}

/**
 * Retrieves all items in the Humble Vault (formerly Humble Trove) catalog from `/home/library`.
 *
 * @param options Runtime options
 * @returns Array of Trove items
 */
export async function getAllTroves(options: Options): Promise<Trove[]> {
  if (!options.update) {
    const cachedTroves = await readJsonFile<Trove[]>(
      options.downloadFolder,
      "troves.json",
    );
    const cmd = options.command?.toLowerCase() ?? COMMANDS.trove;
    if (
      Array.isArray(cachedTroves) &&
      cachedTroves.length > 0 &&
      (!options.authToken || OFFLINE_CACHEABLE_COMMANDS.has(cmd))
    ) {
      return cachedTroves;
    }
  }

  const libProps = await fetchUserLibraryProps(options);
  return convertVaultItemsToTroves(libProps.vaultItems ?? []);
}

/**
 * Requests a signed download URL for a Humble Vault (Trove) asset via the `getVaultSignedUrls` Server Action.
 *
 * @param machine_name Platform download key (e.g. `gettingoveritwithbennettfoddy_linux`)
 * @param web Relative filename (`url.web` or `url.bittorrent`)
 * @param options Runtime options
 * @param subProductId Optional Vault subProduct identifier (e.g. `gettingoveritwithbennettfoddy`)
 * @param forceRefresh Bypass cached signed URLs
 * @returns URL object pointing to signed CDN download
 */
const pendingVaultBatches: {
  options: Options;
  items: Map<
    string,
    {
      resolve: (val: CachedSignedMap) => void;
      reject: (err: unknown) => void;
    }[]
  >;
  timer: ReturnType<typeof setTimeout>;
}[] = [];

function fetchVaultSignedMapBatched(
  subProductId: string,
  options: Options,
  forceRefresh = false,
): Promise<CachedSignedMap> {
  if (forceRefresh) {
    vaultSignedUrlsCache.delete(subProductId);
  } else {
    const existing = vaultSignedUrlsCache.get(subProductId);
    if (existing) {
      return existing.then((cached) => {
        if (cached.expiresAtMs > Date.now() + 5 * 60_000) {
          return cached;
        }
        vaultSignedUrlsCache.delete(subProductId);
        return fetchVaultSignedMapBatched(subProductId, options, true);
      });
    }
  }

  const promise = new Promise<CachedSignedMap>(
    (resolvePromise, rejectPromise) => {
      let batch = pendingVaultBatches.find((b) => b.items.size < 25);
      const flushBatch = (b: (typeof pendingVaultBatches)[number]) => {
        const idx = pendingVaultBatches.indexOf(b);
        if (idx !== -1) pendingVaultBatches.splice(idx, 1);
        const ids = [...b.items.keys()];
        invokeNextServerAction<SignedUrlActionResult>(
          "getVaultSignedUrls",
          LIBRARY_PATH,
          [ids],
          b.options,
        )
          .then((res) => {
            if (!res?.ok || !res.data?.signedUrls) {
              throw new Error(
                res?.code === "denied"
                  ? `Humble Vault access denied (${res.code})`
                  : `Failed to sign Vault URL (${
                    res?.code ?? "unknown error"
                  })`,
              );
            }
            const expiresAtMs = res.data.expiresAt
              ? Date.parse(res.data.expiresAt)
              : Date.now() + 3600_000;
            const sharedMap: CachedSignedMap = {
              signedUrls: res.data.signedUrls,
              expiresAtMs: isNaN(expiresAtMs)
                ? Date.now() + 3600_000
                : expiresAtMs,
            };
            for (const callbacks of b.items.values()) {
              for (const cb of callbacks) cb.resolve(sharedMap);
            }
          })
          .catch((err) => {
            for (const id of ids) vaultSignedUrlsCache.delete(id);
            for (const callbacks of b.items.values()) {
              for (const cb of callbacks) cb.reject(err);
            }
          });
      };

      if (!batch) {
        const newBatch: (typeof pendingVaultBatches)[number] = {
          options,
          items: new Map(),
          timer: setTimeout(() => flushBatch(newBatch), 15),
        };
        pendingVaultBatches.push(newBatch);
        batch = newBatch;
      }

      const list = batch.items.get(subProductId) ?? [];
      list.push({ resolve: resolvePromise, reject: rejectPromise });
      batch.items.set(subProductId, list);

      if (batch.items.size >= 25) {
        clearTimeout(batch.timer);
        flushBatch(batch);
      }
    },
  );

  vaultSignedUrlsCache.set(subProductId, promise);
  return promise;
}

export async function getTroveURL(
  machine_name: string,
  web: string,
  options: Options,
  subProductId?: string,
  forceRefresh = false,
): Promise<URL> {
  const resolvedSubProductId = subProductId ||
    machine_name.replace(
      /_(windows|win|linux|mac|osx|trove)(_[A-Za-z0-9]+)?$/i,
      "",
    );

  const cachedMap = await fetchVaultSignedMapBatched(
    resolvedSubProductId,
    options,
    forceRefresh,
  );
  const signed = lookupSignedUrlInMap(
    cachedMap.signedUrls,
    resolvedSubProductId,
    machine_name,
    web,
  );
  if (!signed) {
    throw new Error(
      `Could not find signed Vault URL for ${web} (${machine_name})`,
    );
  }
  return new URL(signed);
}

/**
 * Posts a JSON run-completion payload to `webhookUrl` (for triggering Komga/Kavita/Audiobookshelf
 * scans or notification webhooks). Never throws on network or HTTP errors.
 */
export async function sendCompletionWebhook(
  webhookUrl: string,
  command: string,
  totals: Totals,
  progress?: MultiBarWrapper,
): Promise<boolean> {
  try {
    const payload = JSON.stringify({
      event: "humblebundle.sync.completed",
      command,
      timestamp: new Date().toISOString(),
      totals,
    });
    const resp = await fetchWithRetry(
      webhookUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": userAgent,
        },
        body: payload,
      },
      2,
    );
    if (!resp.ok) {
      progressDebug(
        progress,
        `Webhook returned HTTP ${resp.status} ${resp.statusText}`,
      );
      return false;
    }
    progressDebug(progress, `Sent completion webhook to ${webhookUrl}`);
    return true;
  } catch (err) {
    progressDebug(
      progress,
      `Webhook delivery failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}
