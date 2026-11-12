import { assertEquals } from "@std/assert";
import { filterTroves } from "../../utils/troves.ts";
import { Trove } from "../../types/trove.ts";
import { Options, Totals } from "../../types/general.ts";
import { MultiBarWrapper } from "../../utils/progressWrapper.ts";

Deno.test("filterTroves - empty list returns empty array", () => {
  const troves: Trove[] = [];
  const options: Options = {
    platform: ["windows"],
    downloadFolder: "/tmp",
    dedup: true,
    bundleFolders: true,
    productFolders: true,
    humanFileNames: false,
    parallel: 5,
    format: [],
    videoQuality: ["best"],
    authToken: "test",
  };
  const totals: Totals = {
    bundles: 0,
    checksums: 0,
    checksumsLoaded: 0,
    hashErrors: 0,
    preFilteredDownloads: 0,
    filteredDownloads: 0,
    removedFiles: 0,
    removedChecksums: 0,
    downloads: 0,
    doneDownloads: 0,
  };
  const progress = {
    log: () => {},
  } as unknown as MultiBarWrapper;

  const result = filterTroves(troves, options, totals, progress);
  assertEquals(result, []);
  assertEquals(totals.filteredDownloads, 0);
});

Deno.test("filterTroves - filters out platforms not selected", () => {
  const troves: Trove[] = [
    {
      machine_name: "test_game",
      "hero-marketing-blurb": null,
      "hero-background-image": null,
      image: "",
      "human-name": "Test Game",
      logo: null,
      "all-access": true,
      "trove-showcase-css": null,
      "youtube-link": null,
      "humble-original": false,
      developers: [],
      "background-color": null,
      "marketing-blurb": "",
      publishers: null,
      downloads: {
        windows: {
          uploaded_at: 1000,
          name: "test.zip",
          url: { web: "test.zip", bittorrent: "" },
          timestamp: 1000,
          machine_name: "test_win",
          file_size: 500,
          small: 0,
          size: "500B",
          md5: "abc",
        },
      },
      "description-text": "",
      "date-added": 1000,
      "background-image": null,
      popularity: 1,
      "hero-character-image": null,
      "hero-game-logo": null,
      "carousel-content": { thumbnail: [], screenshot: [] },
      "date-ended": 0,
      trove_category: "",
      "is-client-hero": null,
    },
  ];

  // Selected platform is Linux, while trove only has Windows
  const options: Options = {
    platform: ["linux"],
    downloadFolder: "/tmp",
    dedup: true,
    bundleFolders: true,
    productFolders: true,
    humanFileNames: false,
    parallel: 5,
    format: [],
    videoQuality: ["best"],
    authToken: "test",
  };
  const totals: Totals = {
    bundles: 0,
    checksums: 0,
    checksumsLoaded: 0,
    hashErrors: 0,
    preFilteredDownloads: 0,
    filteredDownloads: 0,
    removedFiles: 0,
    removedChecksums: 0,
    downloads: 0,
    doneDownloads: 0,
  };
  const progress = {
    log: () => {},
  } as unknown as MultiBarWrapper;

  const result = filterTroves(troves, options, totals, progress);
  assertEquals(result.length, 0);
});

Deno.test("filterTroves - populates webFilename lazily without network calls", async () => {
  const troves: Trove[] = [
    {
      machine_name: "test_game",
      "hero-marketing-blurb": null,
      "hero-background-image": null,
      image: "",
      "human-name": "Test Game",
      logo: null,
      "all-access": true,
      "trove-showcase-css": null,
      "youtube-link": null,
      "humble-original": false,
      developers: [],
      "background-color": null,
      "marketing-blurb": "",
      publishers: null,
      downloads: {
        windows: {
          uploaded_at: 1700000000,
          name: "test.zip",
          url: { web: "folder/test_installer.zip", bittorrent: "" },
          timestamp: 1700000000,
          machine_name: "test_win",
          file_size: 500,
          small: 0,
          size: "500B",
          md5: "abc",
        },
      },
      "description-text": "",
      "date-added": 1700000000,
      "background-image": null,
      popularity: 1,
      "hero-character-image": null,
      "hero-game-logo": null,
      "carousel-content": { thumbnail: [], screenshot: [] },
      "date-ended": 0,
      trove_category: "",
      "is-client-hero": null,
    },
  ];

  const options: Options = {
    platform: ["windows"],
    downloadFolder: "/tmp/trove",
    dedup: true,
    bundleFolders: true,
    productFolders: true,
    humanFileNames: false,
    parallel: 5,
    format: [],
    videoQuality: ["best"],
    authToken: "test",
  };
  const totals: Totals = {
    bundles: 0,
    checksums: 0,
    checksumsLoaded: 0,
    hashErrors: 0,
    preFilteredDownloads: 0,
    filteredDownloads: 0,
    removedFiles: 0,
    removedChecksums: 0,
    downloads: 0,
    doneDownloads: 0,
  };
  const progress = { log: () => {} } as unknown as MultiBarWrapper;

  const result = await filterTroves(troves, options, totals, progress);
  assertEquals(result.length, 1);
  assertEquals(result[0].fileName, "test_installer.zip");
  assertEquals(result[0].webFilename, "folder/test_installer.zip");
  assertEquals(result[0].date.getFullYear(), 2023);
});
