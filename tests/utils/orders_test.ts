import { assertEquals } from "@std/assert";
import { filterBundles, filterEbooks } from "../../utils/orders.ts";
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
      structs: { name?: string; url?: { web: string; bittorrent: string }; sha1?: string; md5?: string; uploaded_at?: string; file_size?: number }[];
    }[];
  }[]
): Bundle {
  return {
    product: { human_name: productName, machine_name: productName.toLowerCase() },
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
    created: "2023-01-01T00:00:00Z",
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
            structs: [{ url: { web: "http://example.com/game1.exe", bittorrent: "" }, sha1: "abc", md5: "123" }],
          },
          {
            platform: Platform.Linux, // Not selected
            structs: [{ url: { web: "http://example.com/game1.tar.gz", bittorrent: "" }, sha1: "def", md5: "456" }],
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
                downloads: [{ platform: Platform.Windows, structs: [{ url: { web: "http://example.com/file.exe", bittorrent: "" }, sha1: "a", md5: "b" }] }],
            }
        ]),
        createMockBundle("Bundle2", [
            {
                machineName: "game1_dupe",
                humanName: "Game 1 Dupe",
                downloads: [{ platform: Platform.Windows, structs: [{ url: { web: "http://example.com/file.exe", bittorrent: "" }, sha1: "c", md5: "d" }] }],
            }
        ])
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
              { name: "PDF", url: { web: "http://example.com/book1.pdf", bittorrent: "" }, uploaded_at: "2023-01-01" },
              { name: "EPUB", url: { web: "http://example.com/book1.epub", bittorrent: "" }, uploaded_at: "2023-01-01" },
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
