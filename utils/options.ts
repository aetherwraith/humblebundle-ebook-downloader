import { includesValue } from "@std/collections/includes-value";
import { cyan, green, red, yellow } from "@std/fmt/colors";
import { exists } from "@std/fs/exists";
import { resolve } from "@std/path";
import { parseCookieInput, parseDateOption, parseSize } from "./generic.ts";
import {
  argAlias,
  argBooleans,
  argDefaults,
  argDescriptions,
  argNoSave,
  argRequired,
  COMMAND_DESCRIPTIONS,
  COMMANDS,
  INVALID_COMMAND_ERROR,
  MISSING_AUTH_TOKEN_ERROR,
  MISSING_DOWNLOAD_FOLDER_ERROR,
  OPTION_SCHEMA,
  optionsFileName,
  SUPPORTED_AUDIO_FORMATS,
  SUPPORTED_FORMATS,
  SUPPORTED_VIDEO_QUALITIES,
  version,
} from "./constants.ts";
import { readJsonFile, writeJsonFile } from "./fileUtils.ts";

import { Options } from "../types/general.ts";
import { Platform } from "../types/bundle.ts";
import { TrovePlatform } from "../types/trove.ts";

const CAMEL_TO_KEBAB_RE = /([A-Z])/g;
const NON_ALNUM_RE = /[^a-zA-Z0-9_]/g;

function toKebabCase(key: string): string {
  return key.replace(CAMEL_TO_KEBAB_RE, "-$1").toLowerCase();
}

function getAliasList(key: string): string[] {
  const alias = argAlias[key];
  return Array.isArray(alias) ? alias : alias ? [alias] : [];
}

function getShortAlias(key: string): string | undefined {
  return getAliasList(key).find((a) => a.length === 1);
}

function sanitizeProgramVar(programName: string): string {
  return programName.replace(NON_ALNUM_RE, "_");
}

function buildExplicitFlagSet(args: string[]): Set<string> {
  const set = new Set<string>();
  for (const arg of args) {
    if (!arg.startsWith("-")) continue;
    const eqIdx = arg.indexOf("=");
    set.add(eqIdx === -1 ? arg : arg.slice(0, eqIdx));
  }
  return set;
}

const READ_ONLY_COMMANDS = new Set<string>([
  COMMANDS.stats,
  COMMANDS.list,
  COMMANDS.bundles,
  COMMANDS.unclaimed,
  COMMANDS.export,
  COMMANDS.verify,
  COMMANDS.checksums,
  COMMANDS.cleanupTrash,
]);

/**
 * Applies settings from `.humblerc.json` and `HUMBLE_*` environment variables
 * for any option not explicitly provided via CLI flags.
 * Priority order: CLI flags > Environment variables > .humblerc.json > Defaults.
 */
export function applyConfigAndEnv(
  options: Options,
  args: string[],
  env: Record<string, string | undefined>,
  configObj: Partial<Options> = {},
): void {
  const passedFlags = buildExplicitFlagSet(args);

  // 1. Apply .humblerc.json values if not explicitly set on CLI
  for (const [key, value] of Object.entries(configObj)) {
    if (value !== undefined && !isOptionExplicitlySet(key, args, passedFlags)) {
      options[key] = value;
    }
  }

  // 2. Apply HUMBLE_* environment variables derived from OPTION_SCHEMA
  for (const [optKey, schema] of Object.entries(OPTION_SCHEMA)) {
    const envKey = schema.env ??
      `HUMBLE_${toKebabCase(optKey).replaceAll("-", "_").toUpperCase()}`;
    const rawVal = env[envKey]?.trim();
    if (rawVal === undefined || rawVal === "") continue;
    if (isOptionExplicitlySet(optKey, args, passedFlags)) continue;

    if (schema.type === "string") {
      options[optKey] = rawVal;
    } else if (schema.type === "boolean") {
      const lower = rawVal.toLowerCase();
      options[optKey] = lower === "true" || lower === "1" || lower === "yes";
    } else if (schema.type === "string[]") {
      options[optKey] = rawVal
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (schema.type === "number") {
      const num = Number(rawVal);
      if (!isNaN(num) && num >= 0) {
        options[optKey] = num;
      }
    }
  }
}

/**
 * Validates, augments, and persists CLI runtime options.
 * Reads defaults from .humblerc.json and HUMBLE_* environment variables,
 * reads saved options from downloadFolder/options.json if available,
 * auto-detects authentication tokens from cookie.txt, and validates arguments.
 *
 * @param options Parsed CLI options
 */
export async function checkOptions(options: Options): Promise<void> {
  // Check for help flag
  if (options.help || options.h) {
    usage();
    Deno.exit(0);
  }

  // Check for version flag
  if (options.version) {
    console.log(options.json ? JSON.stringify({ version }) : version);
    Deno.exit(0);
  }

  // Fast-path `completions` before touching .humblerc.json, env, or cookie.txt
  const firstPositional = options._?.[0]?.toString().toLowerCase();
  if (firstPositional === COMMANDS.completions) {
    validateInitialOptions(options);
    return;
  }

  // Load .humblerc.json from current working directory or XDG config dir
  let rcConfig: Partial<Options> = {};
  if (await exists(".humblerc.json")) {
    rcConfig = await readJsonFile<Partial<Options>>(".", ".humblerc.json");
  } else {
    try {
      const xdgHome = Deno.env.get("XDG_CONFIG_HOME") ||
        (Deno.env.get("HOME") ? resolve(Deno.env.get("HOME")!, ".config") : "");
      if (xdgHome) {
        const globalCfgDir = resolve(xdgHome, "humblebundle-ebook-downloader");
        if (await exists(resolve(globalCfgDir, "config.json"))) {
          rcConfig = await readJsonFile<Partial<Options>>(
            globalCfgDir,
            "config.json",
          );
        }
      }
    } catch {
      // Ignore if --allow-env is not granted
    }
  }
  let envObj: Record<string, string | undefined> = {};
  try {
    envObj = Deno.env.toObject();
  } catch {
    // Ignore if --allow-env is not granted
  }
  applyConfigAndEnv(options, Deno.args, envObj, rcConfig);

  if (options.extractClean) {
    options.extract = true;
  }
  if (options.forceUpdate) {
    options.update = true;
  }

  // Auto-detect authentication cookie file if token is not provided
  if (!options.authToken) {
    const cookieCandidates = ["cookie.txt"];
    if (options.downloadFolder) {
      cookieCandidates.push(resolve(options.downloadFolder, "cookie.txt"));
    }
    for (const candidate of cookieCandidates) {
      if (await exists(candidate)) {
        const cookieContent = await Deno.readTextFile(candidate);
        options.authToken = parseCookieInput(cookieContent);
        if (options.authToken) break;
      }
    }
  }

  validateInitialOptions(options);

  // If authToken is a path to a file containing cookies/tokens, read and parse it
  if (
    options.authToken && options.authToken.length < 1024 &&
    !options.authToken.includes(";")
  ) {
    try {
      const candidatePath = resolve(options.authToken);
      if (await exists(candidatePath)) {
        const cookieContent = await Deno.readTextFile(candidatePath);
        options.authToken = parseCookieInput(cookieContent);
      }
    } catch {
      // Not a valid file path; treat as inline cookie/token string
    }
  }

  const savedOptions = await readJsonFile<Partial<Options>>(
    options.downloadFolder,
    optionsFileName,
  );
  const optionsToSave = initializeOptionsToSave();
  processOptions(options, savedOptions as Options, optionsToSave);

  if (options.showConfig) {
    const redacted = {
      ...options,
      authToken: options.authToken ? "[REDACTED]" : "",
    };
    if (options.json) {
      console.log(JSON.stringify(redacted, null, 2));
    } else {
      console.log(`\n${cyan("=== Effective Configuration ===")}`);
      for (const [k, v] of Object.entries(redacted)) {
        if (k === "_" || v === undefined) continue;
        console.log(`  ${k.padEnd(20)}: ${JSON.stringify(v)}`);
      }
      console.log("");
    }
    Deno.exit(0);
  }

  const hasSavedDiff = Object.keys(optionsToSave).some(
    (k) => !isOptionValueEqual(savedOptions[k], optionsToSave[k]),
  );
  if (
    hasSavedDiff &&
    !options.dryRun &&
    !READ_ONLY_COMMANDS.has(options.command ?? "")
  ) {
    await writeJsonFile(options.downloadFolder, optionsFileName, optionsToSave);
  }
}

/**
 * Validates command line command name (defaulting to 'ebooks' if omitted),
 * download folder, and authentication token.
 */
export function validateInitialOptions(options: Options): void {
  const argsList = options._ ?? [];
  const rawCommandArg = argsList.length === 0
    ? COMMANDS.ebooks
    : argsList[0]?.toString().toLowerCase().replaceAll("-", "");
  const commandArg = rawCommandArg === "video"
    ? COMMANDS.videos
    : rawCommandArg === "ebook"
    ? COMMANDS.ebooks
    : rawCommandArg === "cleanvideo" || rawCommandArg === "cleanupvideo"
    ? COMMANDS.cleanupVideos
    : rawCommandArg;

  if (commandArg === COMMANDS.completions) {
    if (argsList.length > 2) {
      optionError(INVALID_COMMAND_ERROR);
      return;
    }
    options.command = COMMANDS.completions;
    return;
  }

  let hasCachedCatalog = false;
  if (options.downloadFolder && !options.update) {
    try {
      const st = Deno.statSync(resolve(options.downloadFolder, "bundles.json"));
      hasCachedCatalog = st.isFile && st.size > 2;
    } catch {
      hasCachedCatalog = false;
    }
  }
  const canRunWithoutToken = Boolean(options.showConfig) ||
    commandArg === COMMANDS.checksums ||
    commandArg === COMMANDS.cleanupTrash ||
    (hasCachedCatalog &&
      (commandArg === COMMANDS.verify ||
        commandArg === COMMANDS.bundles ||
        commandArg === COMMANDS.unclaimed ||
        commandArg === COMMANDS.stats ||
        commandArg === COMMANDS.list ||
        commandArg === COMMANDS.export));

  if (
    argsList.length > 1 ||
    !commandArg ||
    !includesValue(COMMANDS, commandArg)
  ) {
    optionError(INVALID_COMMAND_ERROR);
  } else if (!options.downloadFolder) {
    optionError(MISSING_DOWNLOAD_FOLDER_ERROR);
  } else if (!canRunWithoutToken && !options.authToken) {
    optionError(MISSING_AUTH_TOKEN_ERROR);
  } else {
    options.command = commandArg;
  }
}

/**
 * Initializes a clean template object containing only persisted option keys (excluding `argNoSave`).
 */
export function initializeOptionsToSave(): Partial<Options> {
  const saved: Partial<Options> = {};
  for (const [key, defaultVal] of Object.entries(argDefaults)) {
    if (!argNoSave.includes(key)) {
      saved[key] = Array.isArray(defaultVal) ? [...defaultVal] : defaultVal;
    }
  }
  return saved;
}

/**
 * Validates option values against supported constraints and handles saved differences.
 */
function processOptions(
  options: Options,
  savedOptions: Options,
  optionsToSave: Partial<Options>,
): void {
  const passedFlags = buildExplicitFlagSet(Deno.args);

  if (options.minSize && parseSize(options.minSize) === undefined) {
    optionError(`Invalid --min-size value: "${options.minSize}"`);
  }
  if (options.maxSize && parseSize(options.maxSize) === undefined) {
    optionError(`Invalid --max-size value: "${options.maxSize}"`);
  }
  if (options.since && parseDateOption(options.since, false) === undefined) {
    optionError(`Invalid --since date: "${options.since}"`);
  }
  if (options.before && parseDateOption(options.before, true) === undefined) {
    optionError(`Invalid --before date: "${options.before}"`);
  }

  for (const key of Object.keys(argDescriptions)) {
    switch (key) {
      case "format":
        options[key] = (options[key] as string[]).map((f) => f.toLowerCase());
        checkArrayOption(options[key] as string[], SUPPORTED_FORMATS);
        break;
      case "audioFormat":
        options[key] = ((options[key] as string[] | undefined) ?? []).map((f) =>
          f.toLowerCase()
        );
        checkArrayOption(options[key] as string[], SUPPORTED_AUDIO_FORMATS);
        break;
      case "videoQuality":
        options[key] = ((options[key] as string[] | undefined) ?? []).map((q) =>
          q.toLowerCase()
        );
        checkArrayOption(
          options[key] as string[],
          SUPPORTED_VIDEO_QUALITIES,
        );
        break;
      case "platform":
        if (
          options.command === COMMANDS.trove ||
          options.command === COMMANDS.cleanupTrove
        ) {
          if (!isOptionExplicitlySet("platform", Deno.args, passedFlags)) {
            options.platform = Object.values(TrovePlatform);
          }
          checkArrayOption(
            options[key] as string[],
            Object.values(TrovePlatform),
          );
          // Do not overwrite Trove platforms with saved bundle platforms (e.g. ["ebook"])
          continue;
        } else {
          checkArrayOption(options[key] as string[], Object.values(Platform));
        }
        break;
    }
    if (!argNoSave.includes(key)) {
      handleOptionDifferences(
        key,
        options,
        savedOptions,
        optionsToSave,
        passedFlags,
      );
    }
  }
}

/**
 * Compares two option values (primitives or arrays) for equality.
 */
export function isOptionValueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if ((a === undefined || a === "") && (b === undefined || b === "")) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, idx) => val === b[idx]);
  }
  return false;
}

/**
 * Checks if a specific CLI option was explicitly passed via command line arguments.
 */
export function isOptionExplicitlySet(
  key: string,
  args: string[],
  passedFlags?: ReadonlySet<string>,
): boolean {
  const flagSet = passedFlags ?? buildExplicitFlagSet(args);
  const kebabKey = toKebabCase(key);
  const candidates = [
    `--${key}`,
    `--${kebabKey}`,
    `--no-${key}`,
    `--no-${kebabKey}`,
  ];
  for (const a of getAliasList(key)) {
    candidates.push(a.length === 1 ? `-${a}` : `--${a}`);
  }
  return candidates.some((flag) => flagSet.has(flag));
}

/**
 * Manages differences between CLI-provided options and previously saved options.
 */
function handleOptionDifferences(
  key: string,
  options: Options,
  savedOptions: Options,
  optionsToSave: Partial<Options>,
  passedFlags?: ReadonlySet<string>,
): void {
  if (options[key] !== undefined) {
    optionsToSave[key] = options[key];
  }
  if (
    Object.hasOwn(savedOptions, key) &&
    !isOptionValueEqual(savedOptions[key], options[key])
  ) {
    if (!isOptionExplicitlySet(key, Deno.args, passedFlags)) {
      // If not explicitly passed on CLI, use the previously saved option
      options[key] = savedOptions[key];
      optionsToSave[key] = savedOptions[key];
    } else if (!options.yes && Deno.stdin.isTerminal()) {
      // Explicitly passed on CLI in interactive terminal, prompt to confirm override
      const useNewValue = promptOptionChange(
        key,
        savedOptions[key],
        options[key],
      );
      if (!useNewValue?.toLowerCase()?.includes("y")) {
        options[key] = savedOptions[key];
        optionsToSave[key] = savedOptions[key];
      }
    }
  }
}

/**
 * Prompts user for interactive confirmation when an option differs from saved configuration.
 */
function promptOptionChange(
  key: string,
  original: unknown,
  newValue: unknown,
): string | null {
  return prompt(
    `${key} differs from saved.\n\toriginal: ${
      JSON.stringify(original)
    }\n\tnew: ${JSON.stringify(newValue)}\nUse new value (y/N)?`,
    "N",
  );
}

/**
 * Logs an error message, outputs usage instructions, and terminates execution.
 */
function optionError(message: string): void {
  console.error(red(`Error: ${message}`));
  usage();
  Deno.exit(1);
}

/**
 * Validates that an array only contains allowed values.
 */
function checkArrayOption(values: string[], validValues: string[]): void {
  if (!values.every((value) => validValues.includes(value))) {
    optionError(
      `${values} contains one or more invalid value. Supported values are ${
        validValues.join(
          ",",
        )
      }`,
    );
  }
}

function getCanonicalFlagLabel(key: string): string {
  const kebab = toKebabCase(key);
  const shortAlias = getShortAlias(key);
  const prefix = shortAlias ? `-${shortAlias}, ` : "    ";
  const negatable = argBooleans.includes(key) &&
      (argDefaults as Record<string, unknown>)[key] === true
    ? ` / --no-${kebab}`
    : "";
  return `${prefix}--${kebab}${negatable}`;
}

/**
 * Outputs formatted CLI usage, commands, and option descriptions to standard output.
 */
export function usage(): void {
  console.log(
    `\n${cyan("Usage:")} humblebundle-ebook-downloader [command] [options]\n`,
  );
  console.log(cyan("Commands:"));
  for (const cmd of Object.values(COMMANDS)) {
    const desc = COMMAND_DESCRIPTIONS[cmd] ?? "";
    console.log(`  ${yellow(cmd.padEnd(16))} ${desc}`);
  }

  console.log(`\n${cyan("Options:")}`);
  for (const [key, desc] of Object.entries(argDescriptions)) {
    const flagStr = getCanonicalFlagLabel(key).padEnd(38);
    const reqBadge = argRequired.includes(key) ? `${red("(Required)")} ` : "";
    console.log(`  ${green(flagStr)} ${reqBadge}${desc}`);
  }
  console.log(`  ${green("-h, --help".padEnd(38))} Show this help message\n`);
}

/**
 * Generates a shell tab-completion script for `bash`, `zsh`, or `fish`.
 */
export function generateShellCompletion(
  shell?: string,
  programName = "humblebundle-ebook-downloader",
): string {
  const detected = (shell || "").trim().toLowerCase() || "bash";
  const commands = Object.values(COMMANDS);
  const longFlags: string[] = ["--help"];
  const shortFlags: string[] = ["-h"];

  for (const key of Object.keys(argDescriptions)) {
    const kebab = toKebabCase(key);
    longFlags.push(`--${kebab}`);
    if (argBooleans.includes(key)) {
      longFlags.push(`--no-${kebab}`);
    }
    for (const a of getAliasList(key)) {
      if (a.length === 1) shortFlags.push(`-${a}`);
    }
  }

  const valueCompletions: Record<string, string> = {
    format: SUPPORTED_FORMATS.join(" "),
    audioFormat: SUPPORTED_AUDIO_FORMATS.join(" "),
    platform: [
      ...new Set([
        ...Object.values(Platform),
        ...Object.values(TrovePlatform),
      ]),
    ].join(" "),
    videoQuality: SUPPORTED_VIDEO_QUALITIES.join(" "),
  };
  const fnName = `_${sanitizeProgramVar(programName)}`;

  if (detected === "fish") {
    const lines = [
      `# Fish completions for ${programName}`,
      `complete -c ${programName} -f`,
    ];
    for (const cmd of commands) {
      const desc = (COMMAND_DESCRIPTIONS[cmd] ?? "").replace(/'/g, "\\'");
      lines.push(
        `complete -c ${programName} -n "__fish_use_subcommand" -a "${cmd}" -d '${desc}'`,
      );
    }
    for (const [key, rawDesc] of Object.entries(argDescriptions)) {
      const kebab = toKebabCase(key);
      const desc = rawDesc.split(".")[0].replace(/'/g, "\\'");
      const short = getShortAlias(key);
      const shortPart = short ? ` -s ${short}` : "";
      const valWords = valueCompletions[key];
      const valPart = valWords ? ` -xa "${valWords}"` : "";
      lines.push(
        `complete -c ${programName}${shortPart} -l ${kebab}${valPart} -d '${desc}'`,
      );
      if (argBooleans.includes(key)) {
        lines.push(
          `complete -c ${programName} -l no-${kebab} -d 'Disable ${kebab}'`,
        );
      }
    }
    return `${lines.join("\n")}\n`;
  }

  if (detected === "zsh") {
    const cmdEntries = commands
      .map((c) => `'${c}:${(COMMAND_DESCRIPTIONS[c] ?? "").replace(/'/g, "")}'`)
      .join(" ");
    const flagEntries: string[] = ["'(-h --help)'{-h,--help}'[Show help]'"];
    for (const [key, rawDesc] of Object.entries(argDescriptions)) {
      const kebab = toKebabCase(key);
      const desc = rawDesc.split(".")[0].replace(/['[\]]/g, "");
      const short = getShortAlias(key);
      const valWords = valueCompletions[key];
      const action = valWords
        ? `:value:(${valWords})`
        : key === "downloadFolder"
        ? ":folder:_files -/"
        : key === "logFile"
        ? ":file:_files"
        : "";
      if (short) {
        flagEntries.push(
          `'(-${short} --${kebab})'{-${short},--${kebab}}'[${desc}]${action}'`,
        );
      } else {
        flagEntries.push(`'--${kebab}[${desc}]${action}'`);
      }
      if (argBooleans.includes(key)) {
        flagEntries.push(`'--no-${kebab}[Disable ${kebab}]'`);
      }
    }
    return `#compdef ${programName}
${fnName}() {
  local -a commands
  commands=(${cmdEntries})
  if (( CURRENT == 2 )); then
    _describe 'command' commands
  fi
  _arguments ${flagEntries.join(" ")}
}
compdef ${fnName} ${programName}
`;
  }

  // Default: bash
  const allWords = [...commands, ...longFlags, ...shortFlags].join(" ");
  return `# Bash completions for ${programName}
${fnName}() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  case "\${prev}" in
    -f|--format)
      COMPREPLY=( $(compgen -W "${valueCompletions.format}" -- "\${cur}") )
      return 0
      ;;
    -a|--audio-format)
      COMPREPLY=( $(compgen -W "${valueCompletions.audioFormat}" -- "\${cur}") )
      return 0
      ;;
    -p|--platform)
      COMPREPLY=( $(compgen -W "${valueCompletions.platform}" -- "\${cur}") )
      return 0
      ;;
    -q|--video-quality)
      COMPREPLY=( $(compgen -W "${valueCompletions.videoQuality}" -- "\${cur}") )
      return 0
      ;;
    -d|--download-folder)
      COMPREPLY=( $(compgen -d -- "\${cur}") )
      return 0
      ;;
    --log-file)
      COMPREPLY=( $(compgen -f -- "\${cur}") )
      return 0
      ;;
  esac
  COMPREPLY=( $(compgen -W "${allWords}" -- "\${cur}") )
}
complete -F ${fnName} ${programName}
`;
}
