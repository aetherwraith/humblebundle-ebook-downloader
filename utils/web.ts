import type { MultiBar, SingleBar } from "cli-progress";
import { userAgent } from "./constants.ts";
import { writeJsonFile } from "./fileUtils.ts";

import { Options, Queues, Totals } from "../types/general.ts";
import { Trove } from "../types/trove.ts";
import { Bundle, GameKey } from "../types/bundle.ts";

// Constants
const BASE_URL = "https://www.humblebundle.com";
const ORDER_PATH = "/api/v1/user/order?ajax=true";

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
) {
  const response = await fetch(`${baseUrl}/api/v1/order/${gameKey}?ajax=true`, {
    headers,
  });
  return await response.json();
}

// Main function to get all bundles
export async function getAllBundles(
  options: Options,
  totals: Totals,
  queues: Queues,
  progress: MultiBar,
) {
  // Create AbortController for request cancellation
  const controller = new AbortController();

  const orderResponse = await fetch(`${BASE_URL}${ORDER_PATH}`, {
    headers: getRequestHeaders(options),
    signal: controller.signal
  });

  if (!orderResponse.ok) {
    throw new Error(`Failed to fetch orders: ${orderResponse.status} ${orderResponse.statusText}`);
  }

  const gameKeys: GameKey[] = await orderResponse.json();
  totals.bundles = gameKeys.length;

  const progressBar: SingleBar = progress.create(gameKeys.length, 0, {
    file: "Bundles",
  });

  // Use a mutex-protected array for thread-safe operations
  const bundlesMutex = new Set<string>();
  const bundles: Bundle[] = [];

  // Create a shared headers object to reduce memory overhead
  const sharedHeaders = getRequestHeaders(options);

  for (const gameKey of gameKeys) {
    queues.orderInfo.add(async () => {
      try {
        // Skip duplicates using the mutex
        if (bundlesMutex.has(gameKey.gamekey)) return;
        bundlesMutex.add(gameKey.gamekey);

        const bundleDetails = await fetchBundleDetails(
          BASE_URL,
          gameKey.gamekey,
          sharedHeaders,
        );
        bundles.push(bundleDetails);
      } catch (err) {
        progress.log(`Error fetching bundle ${gameKey.gamekey}: ${err.message}`);
      } finally {
        progressBar.increment();
      }
    });
  }

  await queues.orderInfo.done();
  progressBar.stop();
  progress.remove(progressBar);

  await writeJsonFile(options.downloadFolder, "bundles.json", bundles);

  // Use faster sort comparison for dates
  return bundles.sort(
    (a, b) => (new Date(b.created).getTime() - new Date(a.created).getTime()),
  );
}

export async function getAllTroves(options: Options) {
  const troves: Trove[] = [];
  let page = 0;
  let done = false;
  while (!done) {
    const troveResponse = await fetch(
      `${BASE_URL}/client/catalog?index=${page}`,
      { headers: getRequestHeaders(options) },
    );
    const troveData = await troveResponse.json();
    if (troveData.length) {
      page += 1;
      troveData.forEach((trove: Trove) => troves.push(trove));
    } else {
      done = true;
    }
  }

  return troves;
}

export async function getTroveURL(
  machine_name: string,
  web: string,
  options: Options,
) {
  const response = await fetch(
    `${BASE_URL}/api/v1/user/download/sign?machine_name=${machine_name}&filename=${web}`,
    { headers: getRequestHeaders(options), method: "POST" },
  );
  const url = await response.json();
  return new URL(url.signed_url);
}
