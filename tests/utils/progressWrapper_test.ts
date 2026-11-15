import { assert, assertEquals } from "@std/assert";
import { cyan } from "@std/fmt/colors";
import { stripAnsi } from "../../utils/generic.ts";
import {
  MultiBarWrapper,
  SingleBarWrapper,
} from "../../utils/progressWrapper.ts";
import { BandwidthLimiter } from "../../utils/streamProgress.ts";

Deno.test("SingleBarWrapper - renderString produces formatted string with bytes", () => {
  const multiBar = new MultiBarWrapper({});
  const bar = new SingleBarWrapper(multiBar, 1024 * 1024, 512 * 1024, {
    file: "test.epub",
    type: "bytes",
  });

  const output = bar.renderString(80);
  assert(output.includes("50.00%"), "Should include percentage");
  assert(output.includes("test.epub"), "Should include file payload");
  assert(output.includes("["), "Should have start bracket");
  assert(output.includes("]"), "Should have end bracket");
});

Deno.test("SingleBarWrapper - renderString produces formatted string with numeric counts", () => {
  const multiBar = new MultiBarWrapper({});
  const bar = new SingleBarWrapper(multiBar, 10, 5, {
    file: "Books",
    type: "number",
  });

  const output = bar.renderString(80);
  assert(output.includes("50.00%"));
  assert(output.includes("5/10"));
  assert(output.includes("Books"));
});

Deno.test("SingleBarWrapper - increment and update change values", () => {
  const multiBar = new MultiBarWrapper({});
  const bar = new SingleBarWrapper(multiBar, 10, 0, {});

  assertEquals(bar.getValue(), 0);
  bar.increment(2);
  assertEquals(bar.getValue(), 2);
  bar.update(7);
  assertEquals(bar.getValue(), 7);
  bar.setTotal(20);
  assertEquals(bar.getTotal(), 20);
  multiBar.stop();
});

Deno.test("MultiBarWrapper - writes INFO and DEBUG logs with stripped ANSI to logFilePath", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const logPath = `${tempDir}/humblebundle.log`;
    const multiBar = new MultiBarWrapper({
      verbose: false,
      logFilePath: logPath,
    });

    multiBar.log("\x1b[32mInfo message\x1b[39m");
    multiBar.debug("Quiet debug diagnostic detail");
    multiBar.stop();

    const logContent = await Deno.readTextFile(logPath);
    assert(logContent.includes("[INFO] Info message"));
    assert(!logContent.includes("\x1b[32m"));
    assert(logContent.includes("[DEBUG] Quiet debug diagnostic detail"));
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("BandwidthLimiter - sets rate and paces bytes without error", async () => {
  const limiter = new BandwidthLimiter(0);
  assertEquals(limiter.getRate(), 0);
  await limiter.consume(1024);

  limiter.setRate(10_000_000); // 10 MB/s -> 1 KB takes 0.1ms (< 5ms threshold)
  assertEquals(limiter.getRate(), 10_000_000);
  await limiter.consume(1024);
});

Deno.test("SingleBarWrapper - renderString accounts for ANSI escape sequences when sizing bar", () => {
  const multiBar = new MultiBarWrapper({});
  const bar = new SingleBarWrapper(multiBar, 100, 50, {
    file: cyan("Downloading: book.epub"),
    type: "number",
  });

  const plainBar = new SingleBarWrapper(multiBar, 100, 50, {
    file: "Downloading: book.epub",
    type: "number",
  });

  const coloredOut = bar.renderString(100);
  const plainOut = plainBar.renderString(100);
  assertEquals(stripAnsi(coloredOut).length, plainOut.length);
  multiBar.stop();
});
