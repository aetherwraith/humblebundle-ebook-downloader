import { assertEquals } from "@std/assert";
import {
  filterAudio,
  filterBundles,
  filterEbooks,
  filterVideos,
} from "../../utils/orders.ts";
import { Bundle, Platform } from "../../types/bundle.ts";
import { DownloadInfo, Options, Totals } from "../../types/general.ts";
import { MultiBarWrapper } from "../../utils/progressWrapper.ts";

function createMockBundle(
  productName: string,
  subProducts: {
    machineName: string;
    humanName: string;
    downloads: {
      platform: Platform;
      structs: {
        name?: string;
        url?: { web: string; bittorrent: string };
        sha1?: string;
        md5?: string;
        uploaded_at?: string;
        file_size?: number;
      }[];
    }[];
  }[],
  created = "2023-01-01T00:00:00Z",
  gamekey = `${productName.toLowerCase()}_key`,
): Bundle {
  return {
    gamekey,
    product: {
      human_name: productName,
      machine_name: productName.toLowerCase(),
    },
    subproducts: subProducts.map((sp) => ({
      machine_name: sp.machineName,
      human_name: sp.humanName,
      downloads: sp.downloads.map((d) => ({
        platform: d.platform,
        download_struct: d.structs.map((s) => ({
          name: s.name,
          url: s.url,
          sha1: s.sha1,
          md5: s.md5,
          uploaded_at: s.uploaded_at,
          file_size: s.file_size,
        })),
      })),
    })),
    created,
  } as unknown as Bundle;
}

const mockProgress = {
  log: () => {},
} as unknown as MultiBarWrapper;

Deno.test("filterBundles - filters by platform", () => {
  const bundles = [
    createMockBundle("Bundle1", [
      {
        machineName: "game1",
        humanName: "Game 1",
        downloads: [
          {
            platform: Platform.Windows,
            structs: [{
              url: { web: "http://example.com/game1.exe", bittorrent: "" },
              sha1: "abc",
              md5: "123",
            }],
          },
          {
            platform: Platform.Linux, // Not selected
            structs: [{
              url: { web: "http://example.com/game1.tar.gz", bittorrent: "" },
              sha1: "def",
              md5: "456",
            }],
          },
        ],
      },
    ]),
  ];

  const options = {
    platform: [Platform.Windows],
    downloadFolder: "/tmp",
    bundleFolders: false,
    productFolders: false,
    dedup: false,
  } as Options;
  const totals = { preFilteredDownloads: 0, filteredDownloads: 0 } as Totals;

  const result = filterBundles(bundles, options, totals, mockProgress);

  assertEquals(result.length, 1);
  assertEquals(result[0].fileName, "game1.exe");
  assertEquals(totals.filteredDownloads, 1);
});

Deno.test("filterBundles - deduplication by filename", () => {
  const bundles = [
    createMockBundle("Bundle1", [
      {
        machineName: "game1",
        humanName: "Game 1",
        downloads: [{
          platform: Platform.Windows,
          structs: [{
            url: { web: "http://example.com/file.exe", bittorrent: "" },
            sha1: "a",
            md5: "b",
          }],
        }],
      },
    ]),
    createMockBundle("Bundle2", [
      {
        machineName: "game1_dupe",
        humanName: "Game 1 Dupe",
        downloads: [{
          platform: Platform.Windows,
          structs: [{
            url: { web: "http://example.com/file.exe", bittorrent: "" },
            sha1: "c",
            md5: "d",
          }],
        }],
      },
    ]),
  ];

  const options = {
    platform: [Platform.Windows],
    downloadFolder: "/tmp",
    dedup: true,
  } as Options;
  const totals = { preFilteredDownloads: 0, filteredDownloads: 0 } as Totals;

  const result = filterBundles(bundles, options, totals, mockProgress);

  assertEquals(result.length, 1, "Should removed duplicate filename");
  assertEquals(result[0].bundle, "Bundle1");
});

Deno.test("filterBundles - deduplication by hash with different filenames", () => {
  const bundles = [
    createMockBundle("Bundle1", [
      {
        machineName: "game1",
        humanName: "Game 1",
        downloads: [{
          platform: Platform.Windows,
          structs: [{
            url: { web: "http://example.com/file_v1.exe", bittorrent: "" },
            sha1: "same_sha1",
            md5: "same_md5",
          }],
        }],
      },
    ]),
    createMockBundle("Bundle2", [
      {
        machineName: "game1_renamed",
        humanName: "Game 1 Renamed",
        downloads: [{
          platform: Platform.Windows,
          structs: [{
            url: { web: "http://example.com/file_v2.exe", bittorrent: "" },
            sha1: "SAME_SHA1",
            md5: "SAME_MD5",
          }],
        }],
      },
    ]),
  ];

  const loggedMessages: string[] = [];
  const captureProgress = {
    log: (...args: unknown[]) => loggedMessages.push(args.join(" ")),
  } as unknown as MultiBarWrapper;

  const options = {
    platform: [Platform.Windows],
    downloadFolder: "/tmp",
    dedup: true,
  } as Options;
  const totals = { preFilteredDownloads: 0, filteredDownloads: 0 } as Totals;

  const result = filterBundles(bundles, options, totals, captureProgress);

  assertEquals(result.length, 1);
  assertEquals(result[0].fileName, "file_v1.exe");
  assertEquals(
    loggedMessages.some((m) => m.includes("Bundle1") && m.includes("file_v1.exe")),
    true,
  );
});

Deno.test("filterEbooks - does not leak subproduct date across subproducts in same bundle", () => {
  const bundles = [
    createMockBundle("BundleOld", [
      {
        machineName: "sub1",
        humanName: "Sub 1",
        downloads: [{
          platform: Platform.Ebook,
          structs: [{
            name: "EPUB",
            url: { web: "http://example.com/sub1.epub", bittorrent: "" },
            uploaded_at: "2026-01-01T00:00:00Z", // Very new upload on sub1
          }],
        }],
      },
      {
        machineName: "sub2",
        humanName: "Sub 2",
        downloads: [{
          platform: Platform.Ebook,
          structs: [{
            name: "EPUB",
            url: { web: "http://example.com/sub2_old.epub", bittorrent: "" },
            // No uploaded_at -> should use bundle created date (2023-01-01), NOT sub1's 2026 date!
          }],
        }],
      },
    ]),
    createMockBundle("BundleNewer", [
      {
        machineName: "sub2",
        humanName: "Sub 2",
        downloads: [{
          platform: Platform.Ebook,
          structs: [{
            name: "EPUB",
            url: { web: "http://example.com/sub2_newer.epub", bittorrent: "" },
            uploaded_at: "2025-01-01T00:00:00Z", // Newer than 2023, older than 2026
          }],
        }],
      },
    ]),
  ];

  const options = {
    platform: [Platform.Ebook],
    format: ["epub"],
    downloadFolder: "/tmp",
    dedup: true,
  } as Options;
  const totals = { preFilteredDownloads: 0, filteredDownloads: 0 } as Totals;

  const result = filterEbooks(bundles, options, totals, mockProgress);
  const sub2 = result.find((r) => r.machineName === "sub2");
  assertEquals(sub2?.fileName, "sub2_newer.epub");
});

Deno.test("filterEbooks - checks format priority", () => {
  const bundles = [
    createMockBundle("BookBundle", [
      {
        machineName: "book1",
        humanName: "Book 1",
        downloads: [
          {
            platform: Platform.Ebook,
            structs: [
              {
                name: "PDF",
                url: { web: "http://example.com/book1.pdf", bittorrent: "" },
                uploaded_at: "2023-01-01",
              },
              {
                name: "EPUB",
                url: { web: "http://example.com/book1.epub", bittorrent: "" },
                uploaded_at: "2023-01-01",
              },
            ],
          },
        ],
      },
    ]),
  ];

  // If we ask for EPUB, we should get EPUB
  let options = {
    platform: [Platform.Ebook],
    format: ["epub"], // lowercase
    downloadFolder: "/tmp",
    dedup: true,
  } as Options;
  let totals = { preFilteredDownloads: 0, filteredDownloads: 0 } as Totals;

  let result = filterEbooks(bundles, options, totals, mockProgress);
  assertEquals(result.length, 1);
  assertEquals(result[0].fileName, "book1.epub");

  // If we ask for both, both should be returned? No, filterEbooks creates 'activeDownloads' and checks by machineName for dedup?
  // Actually filterEbooks iterates formats. If dedupe is on, it picks the best one?
  // Let's check logic:
  // options.format.forEach(format => ...
  //   if dedup: existing = byMachineName.get(...)
  //   if !existing || (date > existing.date && ...)
  //     replace existing

  // It seems it iterates formats in order.
  // If we pass format: ['epub', 'pdf'].
  // 1. Process EPUB. Adds to map.
  // 2. Process PDF. Adds to map IF logic allows.
  // Logic: if !existing || (date > existing.date && struct.name == existing.structName) ??
  // Actually logic is:
  // if !existing || (date > existing.date && isEql(struct.name, existing.structName))
  // Wait, if dates are equal, it doesn't replace.
  // So the FIRST format processed that matches wins if dates are equal?

  // Actually logic:
  // options.format.forEach((format) => { ... })
  // It processes formats in order of options.format.
  // If we have EPUB and PDF in options.
  // 1. Loop 1 (EPUB): finds EPUB. Adds to defaults.
  // 2. Loop 2 (PDF): finds PDF.
  //    existing = EPUB download.
  //    Condition: !existing (False) OR (date > existing (False) && ...)
  //    So it keeps EPUB.
  // So the *first* format in `options.format` has priority if dates are same.

  options = {
    platform: [Platform.Ebook],
    format: ["pdf", "epub"], // PDF first
    downloadFolder: "/tmp",
    dedup: true,
  } as Options;

  result = filterEbooks(bundles, options, totals, mockProgress);
  assertEquals(result.length, 1);
  assertEquals(result[0].fileName, "book1.pdf");
});

Deno.test("createDownloadInfo - humanFileNames distinguishes pdf and pdf_hd so they do not collide", () => {
  const bundles = [
    createMockBundle("ComicBundle", [
      {
        machineName: "infidel",
        humanName: "Infidel",
        downloads: [
          {
            platform: Platform.Ebook,
            structs: [
              {
                name: "PDF",
                url: { web: "http://example.com/infidel.pdf", bittorrent: "" },
              },
              {
                name: "PDF (HD)",
                url: { web: "http://example.com/infidel_hd.pdf", bittorrent: "" },
              },
            ],
          },
        ],
      },
    ]),
  ];

  const options = {
    platform: [Platform.Ebook],
    format: ["pdf", "pdf_hd"],
    downloadFolder: "/tmp",
    bundleFolders: false,
    productFolders: false,
    humanFileNames: true,
    dedup: false,
  } as Options;
  const totals = { preFilteredDownloads: 0, filteredDownloads: 0 } as Totals;

  const result = filterBundles(bundles, options, totals, mockProgress);
  assertEquals(result.length, 2);
  const fileNames = result.map((r) => r.fileName).sort();
  assertEquals(fileNames, ["Infidel.hd.pdf", "Infidel.pdf"]);
});

Deno.test("createDownloadInfo - preserves actual URL extension when struct.name is 'Download' (e.g. Alan Wake Episode 2.mp4)", () => {
  const bundles = [
    createMockBundle("AlanWakeBundle", [
      {
        machineName: "alanwake_ep2",
        humanName: "Alan Wake Episode 2",
        downloads: [
          {
            platform: Platform.Video,
            structs: [
              {
                name: "Download",
                url: {
                  web: "http://example.com/Alan_Wake_Episode_2.mp4",
                  bittorrent: "",
                },
              },
              {
                name: "1080p",
                url: {
                  web: "http://example.com/Alan_Wake_Episode_2_1080p.mkv",
                  bittorrent: "",
                },
              },
            ],
          },
          {
            platform: Platform.Ebook,
            structs: [
              {
                name: "Download",
                url: {
                  web: "http://example.com/Alan_Wake_Files.zip",
                  bittorrent: "",
                },
              },
            ],
          },
        ],
      },
    ]),
  ];

  const options = {
    platform: [Platform.Video, Platform.Ebook],
    format: ["pdf"],
    videoQuality: ["best"],
    downloadFolder: "/tmp",
    bundleFolders: false,
    productFolders: false,
    humanFileNames: false,
    dedup: false,
  } as Options;
  const totals = { preFilteredDownloads: 0, filteredDownloads: 0 } as Totals;

  const result = filterBundles(bundles, options, totals, mockProgress);
  const fileNames = result.map((r) => r.fileName).sort();
  assertEquals(fileNames, [
    "Alan_Wake_Episode_2.mp4",
    "Alan_Wake_Episode_2_1080p.mkv",
    "Alan_Wake_Files.zip",
  ]);

  // Also test with humanFileNames: true and dedup: true (which picks the 1080p video and the zip ebook)
  const humanOptions = {
    ...options,
    humanFileNames: true,
    dedup: true,
    videoQuality: ["1080p", "best"],
  } as Options;
  const humanResult = filterBundles(
    bundles,
    humanOptions,
    totals,
    mockProgress,
  );
  const humanFileNames = humanResult.map((r) => r.fileName).sort();
  assertEquals(humanFileNames, [
    "Alan Wake Episode 2.mkv",
    "Alan Wake Episode 2.zip",
  ]);
});

Deno.test("filterEbooks - excludes non-ebook files (like .mp4 videos) miscategorized by Humble Bundle under platform 'ebook' with name 'Download'", () => {
  const bundles = [
    createMockBundle("MixedBundle", [
      {
        machineName: "alanwake_ep2",
        humanName: "Alan Wake Episode 2",
        downloads: [
          {
            platform: Platform.Ebook, // Miscategorized by Humble Bundle API
            structs: [
              {
                name: "Download",
                url: {
                  web: "http://example.com/Alan_Wake_Episode_2.mp4",
                  bittorrent: "",
                },
              },
            ],
          },
        ],
      },
      {
        machineName: "real_pdf_book",
        humanName: "Real PDF Book",
        downloads: [
          {
            platform: Platform.Ebook,
            structs: [
              {
                name: "Download",
                url: {
                  web: "http://example.com/Real_Book.pdf",
                  bittorrent: "",
                },
              },
            ],
          },
        ],
      },
    ]),
  ];

  const options = {
    platform: [Platform.Ebook],
    format: ["pdf"],
    videoQuality: ["best"],
    downloadFolder: "/tmp",
    dedup: true,
  } as Options;
  const totals = { preFilteredDownloads: 0, filteredDownloads: 0 } as Totals;

  const result = filterEbooks(bundles, options, totals, mockProgress);
  assertEquals(result.length, 1);
  assertEquals(result[0].fileName, "Real_Book.pdf");
});

Deno.test("filterBundles - videoQuality filters highest quality ('best') or '1080p when available, otherwise best'", () => {
  const bundles = [
    createMockBundle("MovieBundle", [
      {
        machineName: "movie_with_4k",
        humanName: "Movie With 4K",
        downloads: [
          {
            platform: Platform.Video,
            structs: [
              {
                name: "720p",
                url: { web: "http://example.com/movie1_720p.mp4", bittorrent: "" },
                file_size: 500_000_000,
              },
              {
                name: "1080p",
                url: { web: "http://example.com/movie1_1080p.mp4", bittorrent: "" },
                file_size: 1_200_000_000,
              },
              {
                name: "4K",
                url: { web: "http://example.com/movie1_2160p.mp4", bittorrent: "" },
                file_size: 3_500_000_000,
              },
            ],
          },
        ],
      },
      {
        machineName: "movie_max_720p",
        humanName: "Movie Max 720p",
        downloads: [
          {
            platform: Platform.Video,
            structs: [
              {
                name: "480p",
                url: { web: "http://example.com/movie2_480p.mp4", bittorrent: "" },
                file_size: 250_000_000,
              },
              {
                name: "720p",
                url: { web: "http://example.com/movie2_720p.mp4", bittorrent: "" },
                file_size: 600_000_000,
              },
            ],
          },
        ],
      },
    ]),
  ];

  // Case 1: "best" -> should pick 4K for Movie 1 and 720p for Movie 2
  const bestOptions = {
    platform: [Platform.Video],
    videoQuality: ["best"],
    downloadFolder: "/tmp",
    dedup: true,
  } as Options;
  const totals = { preFilteredDownloads: 0, filteredDownloads: 0 } as Totals;

  const bestResult = filterBundles(bundles, bestOptions, totals, mockProgress);
  assertEquals(
    bestResult.map((r) => r.fileName).sort(),
    ["movie1_2160p.mp4", "movie2_720p.mp4"],
  );

  // Case 2: ["1080p", "best"] -> should pick 1080p for Movie 1 (even though 4K exists) and fallback to 720p ("best") for Movie 2
  const prefer1080pOptions = {
    platform: [Platform.Video],
    videoQuality: ["1080p", "best"],
    downloadFolder: "/tmp",
    dedup: true,
  } as Options;

  const prefer1080pResult = filterBundles(
    bundles,
    prefer1080pOptions,
    totals,
    mockProgress,
  );
  assertEquals(
    prefer1080pResult.map((r) => r.fileName).sort(),
    ["movie1_1080p.mp4", "movie2_720p.mp4"],
  );

  // Case 3: "worst" -> should pick 720p for Movie 1 and 480p for Movie 2
  const worstOptions = {
    platform: [Platform.Video],
    videoQuality: ["worst"],
    downloadFolder: "/tmp",
    dedup: true,
  } as Options;

  const worstResult = filterBundles(bundles, worstOptions, totals, mockProgress);
  assertEquals(
    worstResult.map((r) => r.fileName).sort(),
    ["movie1_720p.mp4", "movie2_480p.mp4"],
  );
});

Deno.test("filterBundles - supports --min-size, --max-size, --filter, and --torrent", () => {
  const bundles = [
    createMockBundle("SciFiBundle", [
      {
        machineName: "small_errata",
        humanName: "Small Errata",
        downloads: [
          {
            platform: Platform.Ebook,
            structs: [
              {
                name: "PDF",
                url: {
                  web: "http://example.com/errata.pdf",
                  bittorrent: "http://example.com/errata.pdf.torrent",
                },
                file_size: 10_000, // 10 KB
              },
            ],
          },
        ],
      },
      {
        machineName: "main_novel",
        humanName: "Dune Novel",
        downloads: [
          {
            platform: Platform.Ebook,
            structs: [
              {
                name: "EPUB",
                url: {
                  web: "http://example.com/dune.epub",
                  bittorrent: "http://example.com/dune.epub.torrent",
                },
                file_size: 5_000_000, // 5 MB
              },
            ],
          },
        ],
      },
    ]),
  ];

  const options = {
    platform: [Platform.Ebook],
    format: ["epub", "pdf"],
    minSize: "100KB",
    maxSize: "10MB",
    filter: "dune",
    torrent: true,
    humanFileNames: true,
    downloadFolder: "/tmp",
    dedup: true,
  } as Options;
  const totals = { preFilteredDownloads: 0, filteredDownloads: 0 } as Totals;

  const result = filterBundles(bundles, options, totals, mockProgress);
  assertEquals(result.length, 1);
  assertEquals(result[0].fileName, "Dune Novel.epub.torrent");
  assertEquals(result[0].url.href, "http://example.com/dune.epub.torrent");
});

Deno.test("filterBundles & filterEbooks - supports --exclude, --since, and --before", () => {
  const bundles = [
    createMockBundle(
      "Bundle2024",
      [
        {
          machineName: "book_2024",
          humanName: "2024 Book",
          downloads: [
            {
              platform: Platform.Ebook,
              structs: [
                {
                  name: "EPUB",
                  url: { web: "http://example.com/2024.epub", bittorrent: "" },
                  uploaded_at: "2024-06-15T00:00:00Z",
                },
              ],
            },
          ],
        },
      ],
      "2024-06-01T00:00:00Z",
    ),
    createMockBundle(
      "Bundle2025",
      [
        {
          machineName: "book_2025",
          humanName: "2025 Main Book",
          downloads: [
            {
              platform: Platform.Ebook,
              structs: [
                {
                  name: "EPUB",
                  url: { web: "http://example.com/2025.epub", bittorrent: "" },
                  uploaded_at: "2025-03-10T00:00:00Z",
                },
              ],
            },
          ],
        },
        {
          machineName: "sample_2025",
          humanName: "2025 Sample Preview",
          downloads: [
            {
              platform: Platform.Ebook,
              structs: [
                {
                  name: "EPUB",
                  url: { web: "http://example.com/sample.epub", bittorrent: "" },
                  uploaded_at: "2025-03-10T00:00:00Z",
                },
              ],
            },
          ],
        },
      ],
      "2025-03-01T00:00:00Z",
    ),
  ];

  const options = {
    platform: [Platform.Ebook],
    format: ["epub"],
    exclude: "sample|preview",
    since: "2025-01-01",
    before: "2025-12-31",
    downloadFolder: "/tmp",
    dedup: true,
  } as Options;
  const totals = { preFilteredDownloads: 0, filteredDownloads: 0 } as Totals;

  const result = filterEbooks(bundles, options, totals, mockProgress);
  assertEquals(result.length, 1);
  assertEquals(result[0].fileName, "2025.epub");

  // Also test --output-template on the same bundle
  const templatedResult = filterEbooks(
    bundles,
    {
      ...options,
      outputTemplate: "{year}/{bundle}/{product}.{ext}",
    },
    totals,
    mockProgress,
  );
  assertEquals(templatedResult.length, 1);
  assertEquals(
    templatedResult[0].filePath,
    "/tmp/2025/Bundle2025/2025 Main Book.epub",
  );
});

Deno.test("filterBundles & filterEbooks - supports --bundle-key with gamekeys and Humble download URLs", () => {
  const bundles = [
    createMockBundle(
      "AlphaBundle",
      [
        {
          machineName: "alpha_book",
          humanName: "Alpha Book",
          downloads: [
            {
              platform: Platform.Ebook,
              structs: [
                {
                  name: "EPUB",
                  url: { web: "http://example.com/alpha.epub", bittorrent: "" },
                },
              ],
            },
          ],
        },
      ],
      "2025-01-01T00:00:00Z",
      "AbCdEf123456",
    ),
    createMockBundle(
      "BetaBundle",
      [
        {
          machineName: "beta_book",
          humanName: "Beta Book",
          downloads: [
            {
              platform: Platform.Ebook,
              structs: [
                {
                  name: "EPUB",
                  url: { web: "http://example.com/beta.epub", bittorrent: "" },
                },
              ],
            },
          ],
        },
      ],
      "2025-02-01T00:00:00Z",
      "ZyXwVu987654",
    ),
  ];

  const options = {
    platform: [Platform.Ebook],
    format: ["epub"],
    bundleKey: ["https://www.humblebundle.com/downloads?key=ZyXwVu987654"],
    downloadFolder: "/tmp",
    dedup: true,
  } as Options;
  const totals = { preFilteredDownloads: 0, filteredDownloads: 0 } as Totals;

  const ebooks = filterEbooks(bundles, options, totals, mockProgress);
  assertEquals(ebooks.length, 1);
  assertEquals(ebooks[0].fileName, "beta.epub");

  const all = filterBundles(bundles, options, totals, mockProgress);
  assertEquals(all.length, 1);
  assertEquals(all[0].gameKey, "ZyXwVu987654");
});

Deno.test("filterEbooks & filterBundles - 'cb?' prioritizes cbz then cbr ahead of epub/pdf", () => {
  const bundles = [
    createMockBundle("ComicsBundle", [
      {
        machineName: "cbr_only_comic",
        humanName: "Gannibal Vol. 7",
        downloads: [
          {
            platform: Platform.Ebook,
            structs: [
              {
                name: "PDF",
                url: { web: "http://example.com/gannibal_vol7.pdf", bittorrent: "" },
              },
              {
                name: "CBR",
                url: { web: "http://example.com/gannibal_vol7.cbr", bittorrent: "" },
              },
            ],
          },
        ],
      },
      {
        machineName: "both_cbr_and_cbz",
        humanName: "Huck Vol. 1",
        downloads: [
          {
            platform: Platform.Ebook,
            structs: [
              {
                name: "CBR",
                url: { web: "http://example.com/huck_vol1.cbr", bittorrent: "" },
              },
              {
                name: "CBZ",
                url: { web: "http://example.com/huck_vol1.cbz", bittorrent: "" },
              },
              {
                name: "PDF",
                url: { web: "http://example.com/huck_vol1.pdf", bittorrent: "" },
              },
            ],
          },
        ],
      },
    ]),
  ];

  const options = {
    platform: [Platform.Ebook],
    format: ["cb?", "epub", "pdf"],
    downloadFolder: "/tmp",
    dedup: true,
  } as Options;
  const totals = { preFilteredDownloads: 0, filteredDownloads: 0 } as Totals;

  const ebooks = filterEbooks(bundles, options, totals, mockProgress);
  assertEquals(ebooks.length, 2);
  assertEquals(
    ebooks.find((d) => d.machineName === "cbr_only_comic")?.fileName,
    "gannibal_vol7.cbr",
  );
  assertEquals(
    ebooks.find((d) => d.machineName === "both_cbr_and_cbz")?.fileName,
    "huck_vol1.cbz",
  );

  const all = filterBundles(bundles, options, totals, mockProgress);
  assertEquals(all.length, 2);
  assertEquals(
    all.find((d) => d.machineName === "cbr_only_comic")?.fileName,
    "gannibal_vol7.cbr",
  );
  assertEquals(
    all.find((d) => d.machineName === "both_cbr_and_cbz")?.fileName,
    "huck_vol1.cbz",
  );
});

Deno.test("filterAudio & filterVideos - prioritizes audio codecs, comedy specials, supplements, and multi-part courses", () => {
  const bundles = [
    createMockBundle("MediaBundle", [
      {
        machineName: "audiobook_sub",
        humanName: "Kizumonogatari Audiobook",
        downloads: [
          {
            platform: Platform.Audio,
            structs: [
              {
                name: "ZIP",
                url: { web: "http://example.com/kizu-mp3.zip", bittorrent: "" },
              },
              {
                name: "ZIP",
                url: { web: "http://example.com/kizu-flac.zip", bittorrent: "" },
              },
            ],
          },
        ],
      },
      {
        machineName: "comedy_special",
        humanName: "Doug Stanhope Beer Hall Putsch",
        downloads: [
          {
            platform: Platform.Comedy,
            structs: [
              {
                name: "MP4",
                file_size: 400_000_000,
                url: { web: "http://example.com/DougStanhope720.mp4", bittorrent: "" },
              },
              {
                name: "MP4",
                file_size: 900_000_000,
                url: { web: "http://example.com/DougStanhope1080.mp4", bittorrent: "" },
              },
              {
                name: "ZIP",
                file_size: 50_000,
                url: { web: "http://example.com/Doug_Stanhope_Subtitles.zip", bittorrent: "" },
              },
            ],
          },
        ],
      },
      {
        machineName: "comedy_album",
        humanName: "Patrice O'Neal Mr. P",
        downloads: [
          {
            platform: Platform.Comedy,
            structs: [
              {
                name: "MP3",
                url: { web: "http://example.com/mrp_mp3.zip", bittorrent: "" },
              },
              {
                name: "FLAC",
                url: { web: "http://example.com/mrp_flac.zip", bittorrent: "" },
              },
            ],
          },
        ],
      },
      {
        machineName: "multipart_course",
        humanName: "Python Blockchain Course",
        downloads: [
          {
            platform: Platform.Video,
            structs: [
              {
                name: "ZIP",
                file_size: 3_500_000_000,
                url: { web: "http://example.com/course_video_part1.zip", bittorrent: "" },
              },
              {
                name: "ZIP",
                file_size: 3_200_000_000,
                url: { web: "http://example.com/course_video_part2.zip", bittorrent: "" },
              },
              {
                name: "ZIP",
                file_size: 2_000_000,
                url: { web: "http://example.com/course_video_supplement.zip", bittorrent: "" },
              },
            ],
          },
        ],
      },
    ]),
  ];

  const totals = { preFilteredDownloads: 0, filteredDownloads: 0 } as Totals;
  const audioFlac = filterAudio(
    bundles,
    { downloadFolder: "/tmp", dedup: true } as Options,
    totals,
    mockProgress,
  );
  assertEquals(
    audioFlac.map((d) => d.fileName).sort(),
    ["kizu-flac.zip", "mrp_flac.zip"],
  );

  const audioMp3 = filterAudio(
    bundles,
    { downloadFolder: "/tmp", dedup: true, audioFormat: ["mp3", "flac"] } as Options,
    totals,
    mockProgress,
  );
  assertEquals(
    audioMp3.map((d) => d.fileName).sort(),
    ["kizu-mp3.zip", "mrp_mp3.zip"],
  );

  const videos = filterVideos(
    bundles,
    {
      downloadFolder: "/tmp",
      dedup: true,
      videoQuality: ["1080p", "best"],
      humanFileNames: true,
    } as Options,
    totals,
    mockProgress,
  );
  assertEquals(
    videos.map((d) => d.fileName).sort(),
    [
      "Doug Stanhope Beer Hall Putsch.mp4",
      "Doug Stanhope Beer Hall Putsch.zip",
      "Python Blockchain Course (part1).zip",
      "Python Blockchain Course (part2).zip",
      "Python Blockchain Course (supplement).zip",
    ],
  );
});
