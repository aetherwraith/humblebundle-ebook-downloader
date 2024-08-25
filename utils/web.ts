import { userAgent } from "./constants.ts";
import { Bundle, GameKey, Options, Totals } from "./types.ts";
import {writeJsonFile} from "./fileUtils.ts";

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
  queues,
  progress,
) {
  const orderResponse = await fetch(`${BASE_URL}${ORDER_PATH}`, {
    headers: getRequestHeaders(options),
  });
  const gameKeys: GameKey[] = await orderResponse.json();
  totals.bundles = gameKeys.length;

  const progressBar = progress.create(gameKeys.length, 0, { file: "Bundles" });
  const bundles: Bundle[] = [];

  for (const gameKey of gameKeys) {
    queues.orderInfo.add(async () => {
      const bundleDetails = await fetchBundleDetails(
        BASE_URL,
        gameKey.gamekey,
        getRequestHeaders(options),
      );
      bundles.push(bundleDetails);
      progressBar.increment();
    });
  }

  await queues.orderInfo.done();
  progressBar.stop();
  progress.remove(progressBar);

  await writeJsonFile(options.downloadFolder, 'bundles.json', bundles)

  return bundles.sort((a, b) =>
    new Date(b.created).valueOf() - new Date(a.created).valueOf()
  );
}
