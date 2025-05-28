import { userAgent } from "./constants.ts";
import { writeJsonFile } from "./fileUtils.ts";
import { MultiBar } from "./progress.ts";

import { Options, Queues, Totals } from "../types/general.ts";
import { Trove } from "../types/trove.ts";
import { Bundle, GameKey } from "../types/bundle.ts";

// Constants
const BASE_URL = "https://www.humblebundle.com";
const ORDER_PATH = "/api/v1/user/order?ajax=true";

// Request configuration
const REQUEST_TIMEOUT = 30000; // 30 seconds
const RETRY_OPTIONS = {
  maxAttempts: 3,
  baseDelay: 1000,
  maxDelay: 10000,
};

/**
 * Retry a function with exponential backoff
 */
async function retryFetch<T>(
  fetchFn: () => Promise<T>,
  options = RETRY_OPTIONS,
): Promise<T> {
  let lastError: unknown;
  let delay = options.baseDelay;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await fetchFn();
    } catch (err) {
      lastError = err;
      if (attempt >= options.maxAttempts) break;

      // Apply exponential backoff with jitter
      delay = Math.min(delay * 1.5, options.maxDelay);
      const jitter = delay * 0.2 * Math.random();
      await new Promise((resolve) => setTimeout(resolve, delay + jitter));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// Function to create request headers
export function getRequestHeaders(options: Options): Headers {
  const headers = new Headers();
  headers.set("Accept", "application/json");
  headers.set("Accept-Charset", "utf-8");
  headers.set("User-Agent", userAgent);
  headers.set(
    "Cookie",
    `_simpleauth_sess="${options.authToken.replace(/^"|"$/g, "")}";`,
  );
  return headers;
}

// Function to fetch bundle details
async function fetchBundleDetails(
  baseUrl: string,
  gameKey: string,
  headers: Headers,
): Promise<Bundle> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(
      `${baseUrl}/api/v1/order/${gameKey}?ajax=true`,
      {
        headers,
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to fetch bundle details: ${response.status} ${response.statusText}`,
      );
    }

    return await response.json();
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(
        `Request for bundle ${gameKey} timed out after ${
          REQUEST_TIMEOUT / 1000
        }s`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Get all bundles from the Humble Bundle API
 */
export async function getAllBundles(
  options: Options,
  totals: Totals,
  queues: Queues,
  progress: MultiBar,
): Promise<Bundle[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    // Fetch game keys with retry mechanism
    const gameKeys = await retryFetch<GameKey[]>(async () => {
      const response = await fetch(`${BASE_URL}${ORDER_PATH}`, {
        headers: getRequestHeaders(options),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch orders: ${response.status} ${response.statusText}`,
        );
      }

      return await response.json();
    });

    totals.bundles = gameKeys.length;

    const progressBar = progress.create(gameKeys.length, 0, {
      file: "Bundles",
    });

    // Use a set to track processed keys and prevent duplicates
    const processedKeys = new Set<string>();
    const bundles: Bundle[] = [];

    // Create a shared headers object to reduce memory overhead
    const sharedHeaders = getRequestHeaders(options);

    for (const gameKey of gameKeys) {
      queues.orderInfo.add(async () => {
        try {
          // Skip duplicates
          if (processedKeys.has(gameKey.gamekey)) return;
          processedKeys.add(gameKey.gamekey);

          // Use retry mechanism for each bundle fetch
          const bundleDetails = await retryFetch(() =>
            fetchBundleDetails(BASE_URL, gameKey.gamekey, sharedHeaders)
          );
          bundles.push(bundleDetails);
        } catch (err) {
          progress.log(
            `Error fetching bundle ${gameKey.gamekey}: ${
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

    await writeJsonFile(options.downloadFolder, "bundles.json", bundles);

    // Sort bundles by date (newest first)
    return bundles.sort(
      (a, b) => (new Date(b.created).getTime() - new Date(a.created).getTime()),
    );
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(
        `Initial request timed out after ${REQUEST_TIMEOUT / 1000}s`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Get all troves from the Humble Bundle API
 */
export async function getAllTroves(options: Options): Promise<Trove[]> {
  const troves: Trove[] = [];
  let page = 0;
  let done = false;

  while (!done) {
    try {
      // Use retry mechanism for trove catalog fetching
      const troveData = await retryFetch(async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

        try {
          const response = await fetch(
            `${BASE_URL}/client/catalog?index=${page}`,
            {
              headers: getRequestHeaders(options),
              signal: controller.signal,
            },
          );

          if (!response.ok) {
            throw new Error(
              `Failed to fetch trove catalog page ${page}: ${response.status} ${response.statusText}`,
            );
          }

          return await response.json();
        } finally {
          clearTimeout(timeout);
        }
      });

      if (troveData.length) {
        page += 1;
        troves.push(...troveData);
      } else {
        done = true;
      }
    } catch (err) {
      // If a page fails after retries, log error and continue with collected data
      console.error(
        `Failed to fetch trove catalog page ${page} after retries:`,
        err instanceof Error ? err.message : String(err),
      );
      break;
    }
  }

  // Return what we've collected even if incomplete
  return troves;
}

/**
 * Get signed download URL for a trove item
 */
export async function getTroveURL(
  machine_name: string,
  web: string,
  options: Options,
): Promise<URL> {
  return retryFetch(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
      const response = await fetch(
        `${BASE_URL}/api/v1/user/download/sign?machine_name=${
          encodeURIComponent(machine_name)
        }&filename=${encodeURIComponent(web)}`,
        {
          headers: getRequestHeaders(options),
          method: "POST",
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new Error(
          `Failed to get trove URL: ${response.status} ${response.statusText}`,
        );
      }

      const data = await response.json();
      if (!data.signed_url) {
        throw new Error(
          `Invalid response for trove URL request: missing signed_url`,
        );
      }

      return new URL(data.signed_url);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(
          `Trove URL request timed out after ${REQUEST_TIMEOUT / 1000}s`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  });
}
