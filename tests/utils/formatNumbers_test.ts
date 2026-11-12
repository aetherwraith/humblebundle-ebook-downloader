import { assertEquals } from "@std/assert";
import {
  formatFileSize,
  formatPercentage,
  formatTime,
} from "../../utils/formatNumbers.ts";

Deno.test("formatPercentage", () => {
  assertEquals(formatPercentage("12"), " 12");
  assertEquals(formatPercentage("1"), "  1");
  assertEquals(formatPercentage("100"), "100");
});

Deno.test("formatFileSize - percentage", () => {
  assertEquals(formatFileSize("12", {}, "percentage"), " 12");
});

Deno.test("formatFileSize - default", () => {
  // defaults to bytes
  assertEquals(formatFileSize("1024", {}, "default"), "1.02 kB");
  assertEquals(formatFileSize("0", {}, "default"), "0 B");
  assertEquals(formatFileSize("NaN", {}, "default"), "0 B");
});

Deno.test("formatTime - standard cases", () => {
  assertEquals(formatTime(0), "00:00");
  assertEquals(formatTime(59), "00:59");
  assertEquals(formatTime(60), "01:00");
  assertEquals(formatTime(3599), "59:59");
  assertEquals(formatTime(3600), "1:00:00");
  assertEquals(formatTime(3665), "1:01:05");
});

Deno.test("formatTime - edge cases", () => {
  assertEquals(formatTime(NaN), "--:--");
  assertEquals(formatTime(Infinity), "--:--");
});
