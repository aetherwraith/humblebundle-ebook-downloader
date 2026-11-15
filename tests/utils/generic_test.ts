import { assertEquals } from "@std/assert";
import {
  createExcludeMatcher,
  detectAudioFormat,
  detectVideoQuality,
  expandFormatPreferences,
  getExtension,
  matchesFilter,
  normalizeBundleKey,
  normalizeFormat,
  parseBundleKeys,
  parseDateOption,
  parseSize,
  replaceFileExtension,
  resolveOutputTemplate,
  sanitizeFilename,
  stripAnsi,
  stripFileExtension,
} from "../../utils/generic.ts";

Deno.test("sanitizeFilename - strips illegal, control, and reserved characters", () => {
  assertEquals(sanitizeFilename("normal_file.epub"), "normal_file.epub");
  assertEquals(
    sanitizeFilename('bad:file*name?"<>|\\/test.pdf'),
    "badfilenametest.pdf",
  );
  assertEquals(sanitizeFilename("trailing.dots... "), "trailing.dots");
  assertEquals(sanitizeFilename("CON"), "");
  assertEquals(sanitizeFilename(".."), "");
  // Truncates >255 UTF-8 bytes safely
  const longName = "a".repeat(300);
  assertEquals(sanitizeFilename(longName).length, 255);
});

Deno.test("normalizeFormat - handles special format aliases", () => {
  assertEquals(normalizeFormat(".cbz"), "cbz");
  assertEquals(normalizeFormat(".cbr"), "cbr");
  assertEquals(normalizeFormat("cbz"), "cbz");
  assertEquals(normalizeFormat("CBZ"), "cbz");
  assertEquals(normalizeFormat("CBR"), "cbr");
  assertEquals(
    expandFormatPreferences(["cb?", "epub", "pdf"]),
    ["cbz", "cbr", "cb7", "cbt", "cba", "epub", "pdf"],
  );
  assertEquals(
    detectAudioFormat("ZIP", "kizumonogatari_audiobook-flac.zip"),
    "flac",
  );
  assertEquals(
    detectAudioFormat("Bound (MP3)", "Bound.zip"),
    "mp3",
  );
  assertEquals(detectAudioFormat("ZIP", "bastion_ost.zip"), undefined);
  assertEquals(detectVideoQuality("MP4 DougStanhope1080.mp4"), "1080p");
  assertEquals(detectVideoQuality("720p Louis-720_1377554337.zip"), "720p");
  assertEquals(normalizeFormat("PDF (HQ)"), "pdf_hd");
  assertEquals(normalizeFormat("pdf (hd)"), "pdf_hd");
  assertEquals(normalizeFormat("PDF (HD)"), "pdf_hd");
  assertEquals(normalizeFormat("Download"), "pdf");
  assertEquals(normalizeFormat("download"), "pdf");
  assertEquals(normalizeFormat("EPUB"), "epub");
  assertEquals(normalizeFormat("mobi"), "mobi");
  assertEquals(normalizeFormat("custom_format"), "custom_format");
});

Deno.test("getExtension - returns proper file extension", () => {
  assertEquals(getExtension("pdf_hd"), ".hd.pdf");
  assertEquals(getExtension("epub"), ".epub");
  assertEquals(getExtension("cbz"), ".cbz");
  assertEquals(getExtension("mobi"), ".mobi");
  assertEquals(getExtension("pdf"), ".pdf");
});

Deno.test("parseSize - parses human-readable byte sizes", () => {
  assertEquals(parseSize(undefined), undefined);
  assertEquals(parseSize("invalid"), undefined);
  assertEquals(parseSize("100"), 100);
  assertEquals(parseSize("500KB"), 500_000);
  assertEquals(parseSize("1.5 MB"), 1_500_000);
  assertEquals(parseSize("2GB"), 2_000_000_000);
  assertEquals(parseSize("1GiB"), 1024 ** 3);
});

Deno.test("matchesFilter - matches substring and regex case-insensitively", () => {
  assertEquals(matchesFilter(undefined, "Anything"), true);
  assertEquals(
    matchesFilter("warhammer", "Humble Book Bundle: Warhammer 40K"),
    true,
  );
  assertEquals(matchesFilter("^O'Reilly", "O'Reilly Python Bundle"), true);
  assertEquals(matchesFilter("nonexistent", "Book A", "Bundle B"), false);
});

Deno.test("createExcludeMatcher - excludes matching substring or regex", () => {
  const noExclude = createExcludeMatcher(undefined);
  assertEquals(noExclude("Anything"), false);

  const excludeSampler = createExcludeMatcher("sample|ost");
  assertEquals(excludeSampler("Book Sample Chapter"), true);
  assertEquals(excludeSampler("Game OST"), true);
  assertEquals(excludeSampler("Main Book"), false);
});

Deno.test("parseDateOption - parses date-only and ISO dates with start/end of day", () => {
  assertEquals(parseDateOption(undefined), undefined);
  assertEquals(parseDateOption("not-a-date"), undefined);

  const start = parseDateOption("2025-05-01", false);
  assertEquals(start?.toISOString(), "2025-05-01T00:00:00.000Z");

  const end = parseDateOption("2025-05-01", true);
  assertEquals(end?.toISOString(), "2025-05-01T23:59:59.999Z");
});

Deno.test("stripAnsi - removes ANSI color escape codes", () => {
  assertEquals(
    stripAnsi("\x1b[32m10\x1b[39m checksums loaded"),
    "10 checksums loaded",
  );
});

Deno.test("resolveOutputTemplate - expands placeholders and appends extension when missing", () => {
  const res = resolveOutputTemplate(
    "/tmp/dl",
    "{publisher}/{year}/{bundle}/{product}.{ext}",
    {
      bundle: "Python Bundle",
      publisher: "No Starch Press",
      product: "Automate the Boring Stuff",
      format: "epub",
      ext: ".epub",
      year: "2025",
      filename: "automate.epub",
    },
  );
  assertEquals(res.downloadPath, "/tmp/dl/No Starch Press/2025/Python Bundle");
  assertEquals(res.fileName, "Automate the Boring Stuff.epub");
  assertEquals(
    res.filePath,
    "/tmp/dl/No Starch Press/2025/Python Bundle/Automate the Boring Stuff.epub",
  );
});

Deno.test("resolveOutputTemplate - supports month, day, date, gamekey, and platform tokens", () => {
  const res = resolveOutputTemplate(
    "/tmp/dl",
    "{year}/{month}/{day}/{date}/{platform}/{gamekey}/{filename}",
    {
      bundle: "Test Bundle",
      publisher: "Pub",
      product: "Prod",
      format: "EPUB",
      ext: "epub",
      year: "2026",
      month: "03",
      day: "09",
      date: "2026-03-09",
      gamekey: "gk_123",
      platform: "ebook",
      filename: "book.epub",
    },
  );
  assertEquals(res.downloadPath, "/tmp/dl/2026/03/09/2026-03-09/ebook/gk_123");
  assertEquals(res.fileName, "book.epub");
});

Deno.test("stripFileExtension & replaceFileExtension - handles compound and torrent extensions", () => {
  assertEquals(stripFileExtension("/dl/Infidel.hd.pdf"), "/dl/Infidel");
  assertEquals(stripFileExtension("/dl/game.tar.gz"), "/dl/game");
  assertEquals(stripFileExtension("/dl/dune.epub.torrent"), "/dl/dune");
  assertEquals(
    replaceFileExtension("/dl/Infidel.hd.pdf", ".opf"),
    "/dl/Infidel.opf",
  );
  assertEquals(replaceFileExtension("/dl/game.tar.gz", "jpg"), "/dl/game.jpg");
});

Deno.test("normalizeBundleKey & parseBundleKeys - extracts gamekeys from raw strings and Humble URLs", () => {
  assertEquals(
    normalizeBundleKey(
      "https://www.humblebundle.com/downloads?key=aBcDeFgHiJkLmNoP",
    ),
    "aBcDeFgHiJkLmNoP",
  );
  assertEquals(normalizeBundleKey("  rawKey123  "), "rawKey123");

  const parsed = parseBundleKeys([
    "https://www.humblebundle.com/downloads?key=KeyOne",
    "KeyTwo, KeyThree",
  ]);
  assertEquals([...(parsed ?? [])], ["keyone", "keytwo", "keythree"]);
});
