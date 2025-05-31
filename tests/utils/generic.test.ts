import { assertEquals } from "@std/assert";
import { normalizeFormat, getExtension } from "../../utils/generic.ts";

Deno.test("normalizeFormat correctly standardizes format strings", () => {
  assertEquals(normalizeFormat(".cbz"), "cbz");
  assertEquals(normalizeFormat("PDF (HQ)"), "pdf_hd");
  assertEquals(normalizeFormat("pdf (hd)"), "pdf_hd");
  assertEquals(normalizeFormat("download"), "pdf");
  assertEquals(normalizeFormat("EPUB"), "epub");
  assertEquals(normalizeFormat("random"), "random");
});

Deno.test("getExtension returns correct file extension based on format", () => {
  assertEquals(getExtension("pdf"), ".pdf");
  assertEquals(getExtension("epub"), ".epub");
  assertEquals(getExtension("cbz"), ".cbz");
  assertEquals(getExtension("pdf_hd"), ".hd.pdf");
  assertEquals(getExtension("MP3"), ".mp3");
});
