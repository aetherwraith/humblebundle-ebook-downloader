import { userAgent } from "./constants.ts";
import {Bundle, GameKey, Options, Totals} from "./types.ts";

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

export async function getAllBundles(options: Options, totals: Totals, queues, progress) {
  const base = "https://www.humblebundle.com";
  const orderPath = "/api/v1/user/order?ajax=true";
  const orderResponse = await fetch(base + orderPath, {
    headers: getRequestHeaders(options),
  });
  const gameKeys: GameKey[] = await orderResponse.json();
  totals.bundles = gameKeys.length;
  const bundlesBar = progress.create(gameKeys.length, 0, {file: "Bundles"});
  const bundles: Bundle[] = [];
  for (const gameKey of gameKeys) {
    queues.orderInfoQueue.add(async () => {
      bundles.push(
          await fetch(base + `/api/v1/order/${gameKey.gamekey}?ajax=true`, {
            headers: getRequestHeaders(options),
          }).then(async (response) => await response.json()),
      );
      bundlesBar.increment();
    });
  }
  await queues.orderInfoQueue.done();
  bundlesBar.stop();
  progress.remove(bundlesBar);
  return bundles.sort((a, b) => {
        return new Date(b.created).valueOf() - new Date(a.created).valueOf();
      }
  );
}
