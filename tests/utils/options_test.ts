import { assert, assertEquals } from "@std/assert";
import {
  applyConfigAndEnv,
  generateShellCompletion,
  initializeOptionsToSave,
  isOptionExplicitlySet,
  isOptionValueEqual,
  validateInitialOptions,
} from "../../utils/options.ts";
import {
  DEFAULT_AUDIO_FORMATS,
  DEFAULT_FORMATS,
} from "../../utils/constants.ts";
import { Options } from "../../types/general.ts";

Deno.test("isOptionValueEqual - handles primitives and arrays", () => {
  // Primitives
  assertEquals(isOptionValueEqual(true, true), true);
  assertEquals(isOptionValueEqual(true, false), false);
  assertEquals(isOptionValueEqual("hello", "hello"), true);
  assertEquals(isOptionValueEqual("hello", "world"), false);
  assertEquals(isOptionValueEqual(5, 5), true);
  assertEquals(isOptionValueEqual(5, 10), false);

  // Arrays
  assertEquals(isOptionValueEqual(["epub", "pdf"], ["epub", "pdf"]), true);
  assertEquals(isOptionValueEqual(["epub", "pdf"], ["pdf", "epub"]), false);
  assertEquals(isOptionValueEqual(["epub"], ["epub", "pdf"]), false);
  assertEquals(isOptionValueEqual([], []), true);
  assertEquals(isOptionValueEqual(["epub"], null), false);
});

Deno.test("isOptionExplicitlySet - detects camelCase, kebab-case, and aliases", () => {
  const args = ["--download-folder", "/tmp/dl", "-t", "token123", "--parallel=8"];

  assertEquals(isOptionExplicitlySet("downloadFolder", args), true);
  assertEquals(isOptionExplicitlySet("authToken", args), true);
  assertEquals(isOptionExplicitlySet("parallel", args), true);
  assertEquals(isOptionExplicitlySet("dedup", args), false);
  assertEquals(isOptionExplicitlySet("bundleFolders", args), false);

  const negatedArgs = ["--no-dedup", "--no-bundle-folders"];
  assertEquals(isOptionExplicitlySet("dedup", negatedArgs), true);
  assertEquals(isOptionExplicitlySet("bundleFolders", negatedArgs), true);
});

Deno.test("initializeOptionsToSave - returns clean template without argNoSave keys", () => {
  const template = initializeOptionsToSave();
  assertEquals(template.dedup, true);
  assertEquals(template.bundleFolders, true);
  assertEquals(template.productFolders, true);
  assertEquals(template.humanFileNames, false);
  assertEquals(template.parallel, 5);
  assertEquals(template.format, DEFAULT_FORMATS);
  assertEquals(template.audioFormat, DEFAULT_AUDIO_FORMATS);
  assertEquals(template.videoQuality, ["best"]);
  assertEquals(Object.hasOwn(template, "authToken"), false);
  assertEquals(Object.hasOwn(template, "downloadFolder"), false);
  assertEquals(Object.hasOwn(template, "update"), false);
});

Deno.test("validateInitialOptions & generateShellCompletion - completions works without folder or token", () => {
  const options = {
    _: ["completions", "fish"],
    downloadFolder: "",
    authToken: "",
  } as unknown as Options;

  validateInitialOptions(options);
  assertEquals(options.command, "completions");

  const bashScript = generateShellCompletion("bash");
  assert(bashScript.includes("complete -F"));
  assert(bashScript.includes("unclaimed"));

  const zshScript = generateShellCompletion("zsh");
  assert(zshScript.includes("#compdef"));
  assert(zshScript.includes("--bundle-key"));

  const fishScript = generateShellCompletion("fish");
  assert(fishScript.includes("complete -c humblebundle-ebook-downloader"));
  assert(fishScript.includes("-l link-duplicates"));
});

Deno.test("validateInitialOptions - valid ebook command", () => {
  const options: Options = {
    _: ["ebooks"],
    downloadFolder: "/tmp/downloads",
    authToken: "valid_token",
    dedup: true,
    bundleFolders: true,
    productFolders: true,
    humanFileNames: false,
    parallel: 5,
    format: ["epub"],
    platform: ["ebook"],
    videoQuality: ["best"],
  };

  validateInitialOptions(options);
  assertEquals(options.command, "ebooks");

  options._ = ["video"];
  validateInitialOptions(options);
  assertEquals(options.command, "videos");

  options._ = ["audio"];
  validateInitialOptions(options);
  assertEquals(options.command, "audio");
});

Deno.test("validateInitialOptions - checksums command does not require authToken", () => {
  const options: Options = {
    _: ["checksums"],
    downloadFolder: "/tmp/downloads",
    authToken: "",
    dedup: true,
    bundleFolders: true,
    productFolders: true,
    humanFileNames: false,
    parallel: 5,
    format: ["epub"],
    platform: ["ebook"],
    videoQuality: ["best"],
  };

  validateInitialOptions(options);
  assertEquals(options.command, "checksums");
});

Deno.test("validateInitialOptions - defaults to ebooks when command is omitted", () => {
  const options: Options = {
    _: [],
    downloadFolder: "/tmp/downloads",
    authToken: "valid_token",
    dedup: true,
    bundleFolders: true,
    productFolders: true,
    humanFileNames: false,
    parallel: 5,
    format: ["epub"],
    platform: ["ebook"],
    videoQuality: ["best"],
  };

  validateInitialOptions(options);
  assertEquals(options.command, "ebooks");

  options._ = ["video"];
  validateInitialOptions(options);
  assertEquals(options.command, "videos");

  options._ = ["audio"];
  validateInitialOptions(options);
  assertEquals(options.command, "audio");
});

Deno.test("applyConfigAndEnv - applies .humblerc.json and HUMBLE_* env vars while respecting explicit CLI flags", () => {
  const options: Options = {
    _: ["ebooks"],
    downloadFolder: "/cli/dl",
    authToken: "",
    dedup: true,
    bundleFolders: true,
    productFolders: true,
    humanFileNames: false,
    parallel: 5,
    format: ["epub"],
    platform: ["ebook"],
    videoQuality: ["best"],
  };

  const cliArgs = ["--download-folder", "/cli/dl"];
  const env = {
    HUMBLE_AUTH_TOKEN: "env_token_xyz",
    HUMBLE_DOWNLOAD_FOLDER: "/env/dl", // should be ignored because --download-folder is in cliArgs
    HUMBLE_PARALLEL: "12",
    HUMBLE_FORMAT: "cbz, pdf_hd",
    HUMBLE_OPF: "true",
  };
  const rcConfig: Partial<Options> = {
    authToken: "rc_token_old", // should be overridden by HUMBLE_AUTH_TOKEN
    humanFileNames: true,
    covers: true,
  };

  applyConfigAndEnv(options, cliArgs, env, rcConfig);

  assertEquals(options.downloadFolder, "/cli/dl");
  assertEquals(options.authToken, "env_token_xyz");
  assertEquals(options.parallel, 12);
  assertEquals(options.format, ["cbz", "pdf_hd"]);
  assertEquals(options.opf, true);
  assertEquals(options.humanFileNames, true);
  assertEquals(options.covers, true);
});
