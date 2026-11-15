import { assert, assertEquals } from "@std/assert";
import { exists } from "@std/fs";
import { join } from "@std/path";
import {
  buildUnclaimedReport,
  clean,
  computeAndPrintDiff,
  deleteEmptyFolders,
  exportCatalog,
  generateAudioPlaylists,
  getExtractedDirPath,
  isChecksumCacheDirty,
  isExtractableArchive,
  loadChecksumCache,
  pruneTrash,
  readJsonFile,
  walkExistingFiles,
  writeExternalLinkSidecars,
  writeJsonFile,
  writeJsonFileSync,
  writeNfoSidecar,
  writeOpfSidecar,
} from "../../utils/fileUtils.ts";
import { DownloadInfo, Options, Totals } from "../../types/general.ts";
import { Bundle, Checksums } from "../../types/bundle.ts";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("clean - removes extra files and checksums", async () => {
  await withTempDir(async (dir) => {
    const options = { downloadFolder: dir } as Options;
    const totals = { removedFiles: 0, removedChecksums: 0 } as Totals;
    const checksums: Record<string, Checksums> = {
      "keep.txt": { sha1: "abc", md5: "123" },
      "remove.txt": { sha1: "def", md5: "456" },
    };

    // Setup files
    await Deno.writeTextFile(join(dir, "keep.txt"), "keep");
    await Deno.writeTextFile(join(dir, "remove.txt"), "remove");

    // Allowed bundles
    const filteredBundles = [
      { filePath: join(dir, "keep.txt"), fileName: "keep.txt" },
    ] as DownloadInfo[];

    await clean(filteredBundles, checksums, options, totals);

    // Verify files
    assert(await exists(join(dir, "keep.txt")), "keep.txt should exist");
    assertEquals(
      await exists(join(dir, "remove.txt")),
      false,
      "remove.txt should be deleted",
    );

    // Verify checksums
    assert(checksums["keep.txt"], "checksum for keep.txt should remain");
    assertEquals(
      checksums["remove.txt"],
      undefined,
      "checksum for remove.txt should be removed",
    );

    // Verify totals
    assertEquals(totals.removedFiles, 1);
    assertEquals(totals.removedChecksums, 1);
  });
});

Deno.test("deleteEmptyFolders - recursive deletion", async () => {
  await withTempDir(async (dir) => {
    // Structure:
    // /a/b (empty) -> should be deleted
    // /c/d/file.txt -> should NOT be deleted
    // /c/e (empty) -> should be deleted
    // /c -> should remain (contains d)

    const pathA = join(dir, "a");
    const pathB = join(pathA, "b");
    const pathC = join(dir, "c");
    const pathD = join(pathC, "d");
    const pathE = join(pathC, "e");

    await Deno.mkdir(pathB, { recursive: true });
    await Deno.mkdir(pathD, { recursive: true });
    await Deno.mkdir(pathE, { recursive: true });
    await Deno.writeTextFile(join(pathD, "file.txt"), "content");

    await deleteEmptyFolders(dir);

    assertEquals(await exists(pathB), false, "b should be gone");
    assertEquals(
      await exists(pathA),
      false,
      "a should be gone (became empty after b deleted)",
    );
    assertEquals(await exists(pathE), false, "e should be gone");
    assert(await exists(pathD), "d should exist");
    assert(await exists(join(pathD, "file.txt")), "file.txt should exist");
    assert(await exists(pathC), "c should exist");
  });
});

Deno.test("deleteEmptyFolders - preserves root folder even when completely empty", async () => {
  await withTempDir(async (dir) => {
    const emptySub = join(dir, "empty_sub");
    await Deno.mkdir(emptySub, { recursive: true });

    await deleteEmptyFolders(dir);

    assertEquals(await exists(emptySub), false, "empty_sub should be deleted");
    assert(await exists(dir), "root directory itself should be preserved");
  });
});

Deno.test("walkExistingFiles - skips .json, .log, and .part files by default, includes .part when requested", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "checksums.json"), "{}");
    await Deno.writeTextFile(join(dir, "humblebundle.log"), "log line");
    await Deno.writeTextFile(join(dir, "book.pdf.123.part"), "partial");
    await Deno.writeTextFile(join(dir, "learning_json.pdf"), "pdf content");

    const options = { downloadFolder: dir } as Options;
    const defaultWalk: string[] = [];
    for await (const entry of walkExistingFiles(options)) {
      defaultWalk.push(entry.name);
    }
    assertEquals(defaultWalk, ["learning_json.pdf"]);

    const cleanWalk: string[] = [];
    for await (const entry of walkExistingFiles(options, true)) {
      cleanWalk.push(entry.name);
    }
    assertEquals(cleanWalk.sort(), ["book.pdf.123.part", "learning_json.pdf"]);
  });
});

Deno.test("clean - protects activePartFiles and skips when --exclude or --since is set", async () => {
  await withTempDir(async (dir) => {
    const activePart = join(dir, "inflight.pdf.part");
    const stalePart = join(dir, "stale.pdf.part");
    await Deno.writeTextFile(activePart, "active");
    await Deno.writeTextFile(stalePart, "stale");

    // 1. When --exclude is set, clean() skips deletion completely
    const excludeOpts = { downloadFolder: dir, exclude: "sample" } as Options;
    const totals = { removedFiles: 0, removedChecksums: 0 } as Totals;
    await clean([], {}, excludeOpts, totals);
    assert(
      await exists(stalePart),
      "stalePart untouched when --exclude active",
    );

    // 2. Normal clean() with activePartFiles protects activePart while removing stalePart
    const normalOpts = { downloadFolder: dir } as Options;
    await clean([], {}, normalOpts, totals, undefined, new Set([activePart]));
    assert(await exists(activePart), "activePart should be protected");
    assertEquals(await exists(stalePart), false, "stalePart should be deleted");
  });
});

Deno.test("readJsonFile - reads valid JSON and returns empty object on missing or malformed file", async () => {
  await withTempDir(async (dir) => {
    // Missing file
    const missing = await readJsonFile(dir, "non_existent.json");
    assertEquals(missing, {});

    // Malformed JSON
    await Deno.writeTextFile(join(dir, "malformed.json"), "{ invalid json ");
    const malformed = await readJsonFile(dir, "malformed.json");
    assertEquals(malformed, {});

    // Valid JSON
    await Deno.writeTextFile(
      join(dir, "valid.json"),
      JSON.stringify({ a: 1, b: "two" }),
    );
    const valid = await readJsonFile<{ a: number; b: string }>(
      dir,
      "valid.json",
    );
    assertEquals(valid.a, 1);
    assertEquals(valid.b, "two");
  });
});

Deno.test("writeJsonFile & writeJsonFileSync - writes formatted JSON creating directories", async () => {
  await withTempDir(async (dir) => {
    const subDir = join(dir, "sub", "folder");
    const data = { key: "value", count: 42 };

    // Async write
    await writeJsonFile(subDir, "async.json", data);
    const asyncRead = await readJsonFile(subDir, "async.json");
    assertEquals(asyncRead, data);

    // Sync write
    writeJsonFileSync(subDir, "sync.json", data);
    const syncRead = await readJsonFile(subDir, "sync.json");
    assertEquals(syncRead, data);
  });
});

Deno.test("writeOpfSidecar & exportCatalog - generates OPF XML and catalog.json / catalog.csv", async () => {
  await withTempDir(async (dir) => {
    const item: DownloadInfo = {
      name: "Test Book & More",
      bundle: "Tech Bundle",
      publisher: "O'Reilly",
      gameKey: "key123",
      machineName: "test_book",
      fileName: "test_book.epub",
      downloadPath: dir,
      filePath: join(dir, "test_book.epub"),
      url: new URL("https://example.com/test_book.epub"),
      structName: "EPUB",
      date: new Date("2025-05-01T00:00:00Z"),
      file_size: 123456,
      sha1: "abc",
      md5: "def",
    };

    await writeOpfSidecar(item);
    const opfContent = await Deno.readTextFile(join(dir, "test_book.opf"));
    assert(opfContent.includes("<dc:title>Test Book &amp; More</dc:title>"));
    assert(opfContent.includes("<dc:publisher>O&apos;Reilly</dc:publisher>"));

    await exportCatalog([item], dir);
    const catalogJson = await readJsonFile<unknown[]>(dir, "catalog.json");
    assertEquals(catalogJson.length, 1);
    const catalogCsv = await Deno.readTextFile(join(dir, "catalog.csv"));
    assert(catalogCsv.includes('"Test Book & More"'));
  });
});

Deno.test("isExtractableArchive & getExtractedDirPath - identifies archives and computes target folder", () => {
  assert(isExtractableArchive("soundtrack.zip"));
  assert(isExtractableArchive("game_linux.tar.gz"));
  assert(isExtractableArchive("archive.tgz"));
  assertEquals(isExtractableArchive("book.epub"), false);

  assertEquals(
    getExtractedDirPath("/downloads/Bundle/soundtrack.zip"),
    "/downloads/Bundle/soundtrack",
  );
  assertEquals(
    getExtractedDirPath("/downloads/Bundle/game_linux.tar.gz"),
    "/downloads/Bundle/game_linux",
  );
});

Deno.test("generateAudioPlaylists & clean - generates M3U8 playlists and preserves playlists and extracted folders", async () => {
  await withTempDir(async (dir) => {
    const albumDir = join(dir, "OST Bundle", "Game Soundtrack");
    await Deno.mkdir(albumDir, { recursive: true });

    const track1Path = join(albumDir, "01_intro.mp3");
    const track2Path = join(albumDir, "02_boss.flac");
    await Deno.writeTextFile(track1Path, "audio1");
    await Deno.writeTextFile(track2Path, "audio2");

    const archivePath = join(albumDir, "bonus_art.zip");
    const extractedDir = getExtractedDirPath(archivePath);
    const extractedFile = join(extractedDir, "art.png");
    await Deno.mkdir(extractedDir, { recursive: true });
    await Deno.writeTextFile(archivePath, "zipdata");
    await Deno.writeTextFile(extractedFile, "pngdata");

    const items: DownloadInfo[] = [
      {
        name: "Game Soundtrack",
        bundle: "OST Bundle",
        publisher: "Studio",
        gameKey: "k1",
        machineName: "ost_1",
        fileName: "02_boss.flac",
        downloadPath: albumDir,
        filePath: track2Path,
        url: new URL("https://example.com/02_boss.flac"),
        structName: "FLAC",
        date: new Date("2025-01-01T00:00:00Z"),
        file_size: 6,
      },
      {
        name: "Game Soundtrack",
        bundle: "OST Bundle",
        publisher: "Studio",
        gameKey: "k1",
        machineName: "ost_2",
        fileName: "01_intro.mp3",
        downloadPath: albumDir,
        filePath: track1Path,
        url: new URL("https://example.com/01_intro.mp3"),
        structName: "MP3",
        date: new Date("2025-01-01T00:00:00Z"),
        file_size: 6,
      },
      {
        name: "Game Soundtrack",
        bundle: "OST Bundle",
        publisher: "Studio",
        gameKey: "k1",
        machineName: "ost_zip",
        fileName: "bonus_art.zip",
        downloadPath: albumDir,
        filePath: archivePath,
        url: new URL("https://example.com/bonus_art.zip"),
        structName: "ZIP",
        date: new Date("2025-01-01T00:00:00Z"),
        file_size: 7,
      },
    ];

    const generated = await generateAudioPlaylists(items, false);
    assertEquals(generated.length, 1);

    const playlistPath = join(albumDir, "Game Soundtrack.m3u8");
    assert(await exists(playlistPath), "Playlist file should be created");
    const content = await Deno.readTextFile(playlistPath);
    assert(
      content.indexOf("01_intro.mp3") < content.indexOf("02_boss.flac"),
      "Tracks should be sorted naturally",
    );

    // Ensure clean() preserves both the .m3u8 playlist and extracted archive folder when options are enabled
    const options = {
      downloadFolder: dir,
      playlists: true,
      extract: true,
    } as Options;
    const totals = { removedFiles: 0, removedChecksums: 0 } as Totals;
    await clean(items, {}, options, totals);

    assert(
      await exists(playlistPath),
      "Playlist should be preserved by clean()",
    );
    assert(
      await exists(extractedFile),
      "Extracted archive file should be preserved by clean()",
    );
    assertEquals(totals.removedFiles, 0);
  });
});

Deno.test("loadChecksumCache & isChecksumCacheDirty - tracks nested & top-level mutations and resets on writeJsonFile", async () => {
  await withTempDir(async (dir) => {
    await writeJsonFile(dir, "checksums.json", {
      "book.epub": { sha1: "abc" },
    });

    const options = { downloadFolder: dir } as Options;
    const silentProgress = { log: () => {} } as unknown;
    const cache = await loadChecksumCache(
      options,
      silentProgress as Parameters<typeof loadChecksumCache>[1],
    );

    // Reading does not mark dirty
    assertEquals(cache["book.epub"]?.sha1, "abc");
    assertEquals(isChecksumCacheDirty(cache), false);

    // Nested mutation marks dirty
    cache["book.epub"].verifiedSize = 1024;
    assertEquals(isChecksumCacheDirty(cache), true);

    // Saving resets dirty flag
    await writeJsonFile(dir, "checksums.json", cache);
    assertEquals(isChecksumCacheDirty(cache), false);

    // Deleting a key marks dirty
    delete cache["book.epub"];
    assertEquals(isChecksumCacheDirty(cache), true);
  });
});

Deno.test("buildUnclaimedReport - detects unclaimed Choice picks, unredeemed keys, and external links", () => {
  const bundles = [
    {
      gamekey: "choice_key_1",
      created: "2026-03-01T00:00:00Z",
      choices_remaining: 3,
      total_choices: 8,
      product: {
        human_name: "March 2026 Humble Choice",
        machine_name: "march_2026_choice",
        choice_url: "march-2026",
        empty_tpkds: [{ human_name: "Bonus Steam Key" }],
      },
      subproducts: [
        {
          human_name: "External Course",
          machine_name: "external_course",
          downloads: [
            {
              platform: "ebook",
              download_struct: [
                {
                  name: "Redeem Course",
                  external_link: "https://publisher.example.com/redeem",
                },
              ],
            },
          ],
        },
      ],
    },
  ] as unknown as Bundle[];

  const report = buildUnclaimedReport(bundles);
  assertEquals(report.unclaimedChoices.length, 1);
  assertEquals(report.unclaimedChoices[0].choicesRemaining, 3);
  assertEquals(
    report.unclaimedChoices[0].choiceUrl,
    "https://www.humblebundle.com/membership/march-2026",
  );
  assertEquals(report.unredeemedKeys.length, 1);
  assertEquals(report.unredeemedKeys[0].items, ["Bonus Steam Key"]);
  assertEquals(report.externalLinks.length, 1);
  assertEquals(
    report.externalLinks[0].url,
    "https://publisher.example.com/redeem",
  );
  assertEquals(report.unmigratedLegacy.length, 1);
  assertEquals(report.unmigratedLegacy[0].gameKey, "choice_key_1");
});

Deno.test("writeJsonFile - writes compact JSON for large caches and pretty JSON for config files", async () => {
  await withTempDir(async (dir) => {
    await writeJsonFile(dir, "bundles.json", [{ gamekey: "k1" }]);
    await writeJsonFile(dir, "options.json", { parallel: 5 });

    const bundlesRaw = await Deno.readTextFile(join(dir, "bundles.json"));
    const optionsRaw = await Deno.readTextFile(join(dir, "options.json"));

    assertEquals(bundlesRaw, '[{"gamekey":"k1"}]');
    assert(
      optionsRaw.includes("\n"),
      "options.json should remain pretty-printed",
    );
  });
});

Deno.test("writeNfoSidecar - writes album and movie .nfo XML sidecars", async () => {
  await withTempDir(async (dir) => {
    const audioItem: DownloadInfo = {
      name: "OST Track",
      bundle: "Music Bundle",
      publisher: "Composer Studio",
      gameKey: "k1",
      machineName: "ost_track",
      fileName: "track.flac",
      downloadPath: dir,
      filePath: join(dir, "track.flac"),
      url: new URL("https://example.com/track.flac"),
      structName: "FLAC",
      date: new Date("2025-05-10T00:00:00Z"),
    };
    const videoItem: DownloadInfo = {
      name: "Standup Special",
      bundle: "Comedy Bundle",
      publisher: "Comedy Records",
      gameKey: "k2",
      machineName: "special_1",
      fileName: "special.mp4",
      downloadPath: dir,
      filePath: join(dir, "special.mp4"),
      url: new URL("https://example.com/special.mp4"),
      structName: "1080p",
      date: new Date("2025-06-15T00:00:00Z"),
    };

    await writeNfoSidecar(audioItem, true);
    await writeNfoSidecar(videoItem, true);

    const audioNfo = await Deno.readTextFile(join(dir, "track.nfo"));
    const videoNfo = await Deno.readTextFile(join(dir, "special.nfo"));

    assert(audioNfo.includes("<album>"));
    assert(audioNfo.includes("<title>OST Track</title>"));
    assert(videoNfo.includes("<movie>"));
    assert(
      videoNfo.includes("<set>\n    <name>Comedy Bundle</name>\n  </set>"),
    );
  });
});

Deno.test("clean with backupReplaced - moves extra files to .trash and protects .nfo/.trash", async () => {
  await withTempDir(async (dir) => {
    const keepFile = join(dir, "Bundle", "special.mp4");
    const keepNfo = join(dir, "Bundle", "special.nfo");
    const extraFile = join(dir, "Bundle", "old_special.mp4");
    await Deno.mkdir(join(dir, "Bundle"), { recursive: true });
    await Deno.writeTextFile(keepFile, "video");
    await Deno.writeTextFile(keepNfo, "<movie/>");
    await Deno.writeTextFile(extraFile, "old");

    const items: DownloadInfo[] = [{
      name: "Special",
      bundle: "Bundle",
      gameKey: "k1",
      machineName: "special",
      fileName: "special.mp4",
      downloadPath: join(dir, "Bundle"),
      filePath: keepFile,
      url: new URL("https://example.com/special.mp4"),
      structName: "1080p",
      date: new Date(),
    }];
    const options = {
      downloadFolder: dir,
      backupReplaced: true,
    } as Options;
    const totals = { removedFiles: 0, removedChecksums: 0 } as Totals;

    await clean(items, {}, options, totals);
    await deleteEmptyFolders(dir);

    assert(await exists(keepFile));
    assert(
      await exists(keepNfo),
      ".nfo sidecar should be protected by clean()",
    );
    assertEquals(await exists(extraFile), false);
    assert(
      await exists(join(dir, ".trash", "Bundle", "old_special.mp4")),
      "Extra file should be moved into .trash/",
    );
    assertEquals(totals.removedFiles, 1);

    const walked: string[] = [];
    for await (const entry of walkExistingFiles(options)) {
      walked.push(entry.path);
    }
    assertEquals(
      walked.some((p) => p.includes(".trash")),
      false,
      "walkExistingFiles should ignore .trash/",
    );
  });
});

Deno.test("computeAndPrintDiff - reports new bundles, newly migrated bundles, new/changed downloads, and removals", async () => {
  await withTempDir(async (dir) => {
    const prevBundles = [
      {
        gamekey: "legacykey123",
        created: "2013-01-01T00:00:00Z",
        product: {
          human_name: "Classic Bundle",
          machine_name: "classic_bundle",
        },
        subproducts: [],
      },
    ] as unknown as Bundle[];
    const currentBundles = [
      {
        gamekey: "11111111-1111-1111-1111-111111111111",
        created: "2013-01-01T00:00:00Z",
        product: {
          human_name: "Classic Bundle",
          machine_name: "classic_bundle",
        },
        subproducts: [],
      },
      {
        gamekey: "22222222-2222-2222-2222-222222222222",
        created: "2026-01-01T00:00:00Z",
        product: { human_name: "Brand New Bundle", machine_name: "brand_new" },
        subproducts: [],
      },
    ] as unknown as Bundle[];

    const extraPath = join(dir, "stale.epub");
    await Deno.writeTextFile(extraPath, "stale");

    const filtered: DownloadInfo[] = [
      {
        name: "Book A",
        bundle: "Brand New Bundle",
        gameKey: "22222222-2222-2222-2222-222222222222",
        machineName: "book_a",
        fileName: "book_a.epub",
        downloadPath: dir,
        filePath: join(dir, "book_a.epub"),
        url: new URL("https://example.com/book_a.epub"),
        structName: "EPUB",
        date: new Date("2026-01-01T00:00:00Z"),
        sha1: "newhash",
      },
      {
        name: "Book B",
        bundle: "Classic Bundle",
        gameKey: "11111111-1111-1111-1111-111111111111",
        machineName: "book_b",
        fileName: "book_b.epub",
        downloadPath: dir,
        filePath: join(dir, "book_b.epub"),
        url: new URL("https://example.com/book_b.epub"),
        structName: "EPUB",
        date: new Date("2013-01-01T00:00:00Z"),
        sha1: "updated_sha1",
      },
    ];
    const checksums: Record<string, Checksums> = {
      "book_b.epub": { sha1: "old_sha1" },
    };

    const report = await computeAndPrintDiff(
      prevBundles,
      currentBundles,
      filtered,
      checksums,
      { downloadFolder: dir, json: false } as Options,
    );

    assertEquals(report.newlyMigratedBundles.length, 1);
    assertEquals(report.newBundles.length, 1);
    assertEquals(report.newDownloads.length, 1);
    assertEquals(report.changedDownloads.length, 1);
    assertEquals(report.removedFiles.length, 1);
  });
});

Deno.test("pruneTrash - deletes files older than maxAgeDays and preserves recent files", async () => {
  await withTempDir(async (dir) => {
    const trashDir = join(dir, ".trash", "2020-01-01");
    await Deno.mkdir(trashDir, { recursive: true });
    const oldFile = join(trashDir, "old.epub");
    const newFile = join(trashDir, "new.epub");
    await Deno.writeTextFile(oldFile, "old");
    await Deno.writeTextFile(newFile, "new");

    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await Deno.utime(oldFile, oldDate, oldDate);

    const dryDeleted = await pruneTrash(dir, 30, true);
    assertEquals(dryDeleted, 1);
    assertEquals(await exists(oldFile), true);

    const realDeleted = await pruneTrash(dir, 30, false);
    assertEquals(realDeleted, 1);
    assertEquals(await exists(oldFile), false);
    assertEquals(await exists(newFile), true);
  });
});

Deno.test("writeExternalLinkSidecars - creates .url sidecar files for external-link items", async () => {
  await withTempDir(async (dir) => {
    const bundles: Bundle[] = [
      {
        gamekey: "gk_ext_1",
        created: "2026-01-01T00:00:00Z",
        product: {
          machine_name: "ext_bundle",
          human_name: "External Bundle",
          category: "bundle",
          empty_tpkds: {},
          post_purchase_text: "",
        },
        subproducts: [
          {
            machine_name: "ext_sub",
            human_name: "External Course",
            url: "",
            downloads: [
              {
                platform: "ebook",
                machine_name: "ext_dl",
                download_struct: [
                  {
                    name: "Course Link",
                    external_link: "https://example.com/course",
                  },
                ],
              },
            ],
            payee: { human_name: "Maker", machine_name: "maker" },
            icon: "",
            custom_download_page_box_css: "",
            custom_download_page_box_html: "",
          },
        ],
        tpkd_dict: { all_tpks: [] },
      } as unknown as Bundle,
    ];

    const created = await writeExternalLinkSidecars(bundles, {
      downloadFolder: dir,
      bundleFolders: true,
      dryRun: false,
    } as Options);

    assertEquals(created, 1);
    const sidecarPath = join(
      dir,
      "External Bundle",
      "External Course (Course Link).url",
    );
    assertEquals(await exists(sidecarPath), true);
    const content = await Deno.readTextFile(sidecarPath);
    assert(content.includes("URL=https://example.com/course"));
  });
});
