import { assertEquals, assertRejects } from "@std/assert";
import {
  convertLibraryItemToBundle,
  convertVaultItemsToTroves,
  encodeRfc3986Path,
  fetchBundleDetails,
  getRequestHeaders,
  isMigratedPlatformKey,
  mergeUnmigratedLegacyBundles,
  parseRscStream,
  refreshDownloadUrl,
  resolveFlightRefs,
} from "../../utils/web.ts";
import { normalizeBundleKey, parseCookieInput } from "../../utils/generic.ts";
import { DownloadInfo, Options } from "../../types/general.ts";
import { Bundle } from "../../types/bundle.ts";
import { userAgent } from "../../utils/constants.ts";

Deno.test("getRequestHeaders - correctly strips quotes and sets cookie & user-agent", () => {
  const options: Options = {
    authToken: '"my_secret_session_token"',
    downloadFolder: "/tmp",
    dedup: true,
    bundleFolders: true,
    productFolders: true,
    humanFileNames: false,
    parallel: 5,
    format: [],
    platform: [],
    videoQuality: ["best"],
  };

  const headers = getRequestHeaders(options);
  assertEquals(headers.get("User-Agent"), userAgent);
  assertEquals(headers.get("Accept"), "application/json");
  assertEquals(headers.get("Cookie"), '_simpleauth_sess="my_secret_session_token";');
});

Deno.test("refreshDownloadUrl - throws when download cannot be matched", async () => {
  const download: DownloadInfo = {
    date: new Date(),
    bundle: "Test Bundle",
    gameKey: "non_existent_key",
    name: "Test Name",
    fileName: "test.epub",
    downloadPath: "/tmp",
    filePath: "/tmp/test.epub",
    url: new URL("http://example.com/test.epub"),
    machineName: "non_existent_machine",
    structName: "test.epub",
  };

  const options: Options = {
    authToken: "dummy_token",
    downloadFolder: "/tmp",
    dedup: true,
    bundleFolders: true,
    productFolders: true,
    humanFileNames: false,
    parallel: 5,
    format: [],
    platform: [],
    videoQuality: ["best"],
  };

  // refreshDownloadUrl tries to fetch bundle details from Humble Bundle with dummy token, which fails
  await assertRejects(
    async () => {
      await refreshDownloadUrl(download, options);
    },
    Error,
  );
});

Deno.test("parseCookieInput & normalizeBundleKey - supports Netscape cookies.txt, Ory cookies, and /home/library URLs", () => {
  const netscape = [
    "# Netscape HTTP Cookie File",
    "#HttpOnly_.humblebundle.com\tTRUE\t/\tTRUE\t1800000000\tory_session_abc\tsess_val_123",
    ".humblebundle.com\tTRUE\t/\tTRUE\t1800000000\tcf_clearance\tcf_456",
    ".example.com\tTRUE\t/\tTRUE\t1800000000\tother\tignored",
  ].join("\n");

  assertEquals(
    parseCookieInput(netscape),
    "ory_session_abc=sess_val_123; cf_clearance=cf_456",
  );
  assertEquals(
    parseCookieInput("Cookie: ory_session_xyz=tok999; __cf_bm=bm1"),
    "ory_session_xyz=tok999; __cf_bm=bm1",
  );
  assertEquals(
    normalizeBundleKey(
      "https://www.humblebundle.com/home/library/c7a551c0-0d75-4f36-86d3-491180af3cb7",
    ),
    "c7a551c0-0d75-4f36-86d3-491180af3cb7",
  );
  assertEquals(
    normalizeBundleKey(
      "https://www.humblebundle.com/home/library/group/c7a551c0-0b11-4ee2-8698-df67428bbdd0",
    ),
    "group/c7a551c0-0b11-4ee2-8698-df67428bbdd0",
  );
  assertEquals(
    isMigratedPlatformKey("c7a551c0-0d75-4f36-86d3-491180af3cb7"),
    true,
  );
  assertEquals(
    isMigratedPlatformKey("group/c7a551c0-0b11-4ee2-8698-df67428bbdd0"),
    true,
  );
  assertEquals(isMigratedPlatformKey("Eu2756Hf8RT4"), false);
});

Deno.test("mergeUnmigratedLegacyBundles - retains unmigrated legacy bundles and skips migrated ones", () => {
  const makeBundle = (
    gamekey: string,
    title: string,
    subMachines: string[],
  ): Bundle =>
    ({
      gamekey,
      created: "2013-07-06T00:00:00Z",
      product: { human_name: title },
      subproducts: subMachines.map((m) => ({
        machine_name: m,
        human_name: m,
        downloads: [{ machine_name: `${m}_ebook`, download_struct: [] }],
      })),
    }) as unknown as Bundle;

  const live = [
    makeBundle(
      "c7a551c0-08ec-4ed8-886f-0692dccf3881",
      "Humble Book Bundle: Adventures in Science Fiction",
      ["across_billion_years", "forge_of_god"],
    ),
  ];
  const legacyPool = [
    makeBundle(
      "migratedKey1",
      "Humble Book Bundle: Adventures in Science Fiction",
      ["across_billion_years", "forge_of_god"],
    ),
    makeBundle("renamedMigratedKey", "Adventures in SF (Old Title)", [
      "across_billion_years",
      "forge_of_god",
    ]),
    makeBundle("DNabs77e4yba", "Humble eBook Bundle 2", [
      "boneshaker",
      "last_unicorn",
    ]),
  ];

  const retained = mergeUnmigratedLegacyBundles(
    live,
    legacyPool,
    new Set(["humble book bundle: adventures in science fiction"]),
  );
  assertEquals(retained.length, 1);
  assertEquals(retained[0].gamekey, "DNabs77e4yba");
});

Deno.test("parseRscStream, resolveFlightRefs & encodeRfc3986Path - parses React Flight binary/text and JSON rows", () => {
  const textPayload = "Hello\nMultiline World!";
  const hexLen = new TextEncoder().encode(textPayload).byteLength.toString(16);
  const streamStr =
    `1:T${hexLen},${textPayload}2:{"msg":"$1","empty":"$undefined"}\n`;
  const rows = parseRscStream(new TextEncoder().encode(streamStr));
  const resolved = resolveFlightRefs(rows.get("2"), rows) as Record<
    string,
    unknown
  >;

  assertEquals(resolved.msg, textPayload);
  assertEquals(resolved.empty, undefined);
  assertEquals(
    encodeRfc3986Path("Bonus Art (HD)/ Kid's Track!.mp3"),
    "Bonus%20Art%20%28HD%29/%20Kid%27s%20Track%21.mp3",
  );
});

Deno.test("convertVaultItemsToTroves & convertLibraryItemToBundle - maps Next.js library schemas", () => {
  const troves = convertVaultItemsToTroves([
    {
      id: "v1",
      title: "Getting Over It with Bennett Foddy (subscriber_vault)",
      entitlements: {
        downloads: [
          {
            id: "gettingoveritwithbennettfoddy",
            downloads: [
              {
                key: "gettingoveritwithbennettfoddy_linux",
                platform: "linux",
                downloadStruct: [
                  {
                    name: "ZIP",
                    fileSize: 1128366350,
                    sha1: "49865256daab264ccf63e9d2e1813cf0e68a344d",
                    md5: "f66f6b1c9d2c7afd01eabd0cbe544498",
                    url: {
                      web: "gettingoveritwithbennettfoddy_linux.zip",
                      bittorrent: "gettingoveritwithbennettfoddy_linux.zip.torrent",
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  ]);

  assertEquals(troves.length, 1);
  assertEquals(troves[0]["human-name"], "Getting Over It with Bennett Foddy");
  assertEquals(troves[0].subProductId, "gettingoveritwithbennettfoddy");
  assertEquals(
    troves[0].downloads.linux?.url.web,
    "gettingoveritwithbennettfoddy_linux.zip",
  );

  const bundle = convertLibraryItemToBundle("bundle-uuid-1", {
    id: "item-uuid-1",
    title: "Humble Book Bundle: Sci-Fi Classics by Open Road Media",
    entitlements: {
      keys: [{ id: "k1", title: "Bonus Key" }],
      downloads: [
        {
          id: "ent-dl-1",
          title: "Cryptozoic!",
          downloads: [
            {
              key: "cryptozoic_ebook",
              platform: "ebook",
              createdAt: "2026-09-21T20:16:26.224Z",
              downloadStruct: [
                {
                  name: "EPUB",
                  fileSize: 2194746,
                  sha1: "032993cb0778266270cf5a888c71b91c28f2533f",
                  url: { web: "cryptozoic.epub" },
                },
              ],
            },
          ],
        },
      ],
    },
  });

  assertEquals(bundle.gamekey, "bundle-uuid-1");
  assertEquals(bundle.subproducts.length, 1);
  assertEquals(bundle.subproducts[0].entitlement_id, "ent-dl-1");
  assertEquals(bundle.subproducts[0].machine_name, "cryptozoic");
  assertEquals(bundle.subproducts[0].payee.human_name, "Open Road Media");
});

Deno.test("fetchBundleDetails - requests RSC Flight stream (RSC: 1) and parses text/x-component directly", async () => {
  let receivedRscHeader: string | null = null;
  let receivedAccept: string | null = null;
  let receivedPath = "";

  const rscBody = [
    '1:I[123,["static/chunks/app-item.js"],"default"]',
    '2:{"userLibraryItem":{"id":"item-rsc-1","title":"Humble Tech Book Bundle by O\'Reilly","entitlements":{"downloads":[{"id":"ent-rsc-1","title":"Designing Data-Intensive Applications","downloads":[{"key":"ddia_ebook","platform":"ebook","createdAt":"2026-05-01T00:00:00.000Z","downloadStruct":[{"name":"EPUB","fileSize":123456,"sha1":"abc123def","url":{"web":"ddia.epub"}}]}]}]}}}',
    "",
  ].join("\n");

  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: () => {} },
    (req) => {
      const u = new URL(req.url);
      receivedPath = u.pathname;
      receivedRscHeader = req.headers.get("rsc");
      receivedAccept = req.headers.get("accept");
      return new Response(rscBody, {
        status: 200,
        headers: { "content-type": "text/x-component; charset=utf-8" },
      });
    },
  );

  try {
    const baseUrl = `http://127.0.0.1:${server.addr.port}`;
    const bundle = await fetchBundleDetails(
      baseUrl,
      "group/test-uuid-99",
      new Headers(),
    );

    assertEquals(receivedPath, "/home/library/group/test-uuid-99");
    assertEquals(receivedRscHeader, "1");
    assertEquals(receivedAccept, "text/x-component");
    assertEquals(bundle.gamekey, "group/test-uuid-99");
    assertEquals(bundle.product.human_name, "Humble Tech Book Bundle by O'Reilly");
    assertEquals(bundle.subproducts.length, 1);
    assertEquals(bundle.subproducts[0].human_name, "Designing Data-Intensive Applications");
    assertEquals(bundle.subproducts[0].downloads[0].download_struct[0].sha1, "abc123def");
  } finally {
    ac.abort();
    await server.finished;
  }
});
