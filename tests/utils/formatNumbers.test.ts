import { assertEquals } from "@std/assert";
import { formatPercentage, formatBytes, formatFileSize } from "../../utils/formatNumbers.ts";

Deno.test("formatPercentage pads strings to 3 characters", () => {
  assertEquals(formatPercentage("1"), "  1");
  assertEquals(formatPercentage("12"), " 12");
  assertEquals(formatPercentage("100"), "100");
  assertEquals(formatPercentage(""), "   ");
});

Deno.test("formatBytes converts bytes to human-readable format", () => {
  assertEquals(formatBytes(0), "0B");
  assertEquals(formatBytes(1023), "1023B");
  assertEquals(formatBytes(1024), "1KB");
  assertEquals(formatBytes(1024 * 1024), "1MB");
  assertEquals(formatBytes(1024 * 1024 * 1024), "1GB");
  assertEquals(formatBytes(1500), "1.46KB");
});

Deno.test("formatFileSize handles percentage variant", () => {
  assertEquals(formatFileSize("50", undefined, "percentage"), " 50");
  assertEquals(formatFileSize("100", undefined, "percentage"), "100");
});

Deno.test("formatFileSize handles bytes variant (default)", () => {
  assertEquals(formatFileSize("1024"), "1KB");
  assertEquals(formatFileSize("1048576"), "1MB");
  assertEquals(formatFileSize("invalid"), "0B");
});
