import { includesValue } from "@std/collections/includes-value";
import { cyan, green, red, yellow } from "@std/fmt/colors";
import { exists } from "@std/fs/exists";
import { resolve } from "@std/path";
import { parseCookieInput } from "./generic.ts";
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
  optionsFileName,
  SUPPORTED_AUDIO_FORMATS,
  SUPPORTED_FORMATS,
  SUPPORTED_VIDEO_QUALITIES,
} from "./constants.ts";
import { readJsonFile, writeJsonFile } from "./fileUtils.ts";

import { Options } from "../types/general.ts";
import { Platform } from "../types/bundle.ts";
import { TrovePlatform } from "../types/trove.ts";

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
  // 1. Apply .humblerc.json values if not explicitly set on CLI
  for (const [key, value] of Object.entries(configObj)) {
    if (value !== undefined && !isOptionExplicitlySet(key, args)) {
      options[key] = value;
    }
  }

  // 2. Apply HUMBLE_* environment variables if not explicitly set on CLI
  const envStringMap: Record<string, string> = {
    downloadFolder: "HUMBLE_DOWNLOAD_FOLDER",
    authToken: "HUMBLE_AUTH_TOKEN",
    filter: "HUMBLE_FILTER",
    exclude: "HUMBLE_EXCLUDE",
    since: "HUMBLE_SINCE",
    before: "HUMBLE_BEFORE",
    maxSize: "HUMBLE_MAX_SIZE",
    minSize: "HUMBLE_MIN_SIZE",
    rateLimit: "HUMBLE_RATE_LIMIT",
    outputTemplate: "HUMBLE_OUTPUT_TEMPLATE",
    webhook: "HUMBLE_WEBHOOK",
    logFile: "HUMBLE_LOG_FILE",
  };
  for (const [optKey, envKey] of Object.entries(envStringMap)) {
    const val = env[envKey]?.trim();
    if (val && !isOptionExplicitlySet(optKey, args)) {
      options[optKey] = val;
    }
  }

  const envBoolMap: Record<string, string> = {
    dedup: "HUMBLE_DEDUP",
    bundleFolders: "HUMBLE_BUNDLE_FOLDERS",
    productFolders: "HUMBLE_PRODUCT_FOLDERS",
    humanFileNames: "HUMBLE_HUMAN_FILE_NAMES",
    update: "HUMBLE_UPDATE",
    dryRun: "HUMBLE_DRY_RUN",
    opf: "HUMBLE_OPF",
    covers: "HUMBLE_COVERS",
    torrent: "HUMBLE_TORRENT",
    extract: "HUMBLE_EXTRACT",
    playlists: "HUMBLE_PLAYLISTS",
    preserveMtime: "HUMBLE_PRESERVE_MTIME",
    linkDuplicates: "HUMBLE_LINK_DUPLICATES",
    deep: "HUMBLE_DEEP",
    json: "HUMBLE_JSON",
    verbose: "HUMBLE_VERBOSE",
  };
  for (const [optKey, envKey] of Object.entries(envBoolMap)) {
    const val = env[envKey]?.trim().toLowerCase();
    if (val !== undefined && val !== "" && !isOptionExplicitlySet(optKey, args)) {
      options[optKey] = val === "true" || val === "1" || val === "yes";
    }
  }

  const envArrayMap: Record<string, string> = {
    format: "HUMBLE_FORMAT",
    audioFormat: "HUMBLE_AUDIO_FORMAT",
    platform: "HUMBLE_PLATFORM",
    videoQuality: "HUMBLE_VIDEO_QUALITY",
    bundleKey: "HUMBLE_BUNDLE_KEY",
  };
  for (const [optKey, envKey] of Object.entries(envArrayMap)) {
    const val = env[envKey]?.trim();
    if (val && !isOptionExplicitlySet(optKey, args)) {
      options[optKey] = val
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  const parallelEnv = env["HUMBLE_PARALLEL"]?.trim();
  if (parallelEnv && !isOptionExplicitlySet("parallel", args)) {
    const num = Number(parallelEnv);
    if (!isNaN(num) && num > 0) {
      options.parallel = num;
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

  // Load .humblerc.json from current working directory if present
  let rcConfig: Partial<Options> = {};
  if (await exists(".humblerc.json")) {
    rcConfig = await readJsonFile<Partial<Options>>(".", ".humblerc.json");
  }
  let envObj: Record<string, string | undefined> = {};
  try {
    envObj = Deno.env.toObject();
  } catch {
    // Ignore if --allow-env is not granted
  }
  applyConfigAndEnv(options, Deno.args, envObj, rcConfig);

  // Auto-detect authentication cookie file if token is not provided
  if (!options.authToken && (await exists("cookie.txt"))) {
    const cookieContent = await Deno.readTextFile("cookie.txt");
    options.authToken = parseCookieInput(cookieContent);
  }

  validateInitialOptions(options);
  if (options.command === COMMANDS.completions) {
    return;
  }

  // If authToken is a path to a file containing cookies/tokens, read and parse it
  if (options.authToken && options.authToken.length < 1024 && !options.authToken.includes(";")) {
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
  await writeJsonFile(options.downloadFolder, optionsFileName, optionsToSave);
}

/**
 * Validates command line command name (defaulting to 'ebooks' if omitted),
 * download folder, and authentication token.
 */
export function validateInitialOptions(options: Options): void {
  const argsList = options._ ?? [];
  const rawCommandArg = argsList.length === 0
    ? COMMANDS.ebooks
    : argsList[0]?.toString().toLowerCase();
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
  const canRunWithoutToken =
    commandArg === COMMANDS.checksums ||
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
        checkArrayOption(
          (options[key] as string[]).map((q) => q.toLowerCase()),
          SUPPORTED_VIDEO_QUALITIES,
        );
        break;
      case "platform":
        if (
          options.command === COMMANDS.trove ||
          options.command === COMMANDS.cleanupTrove
        ) {
          if (!isOptionExplicitlySet("platform", Deno.args)) {
            options.platform = Object.values(TrovePlatform);
          }
          checkArrayOption(
            options[key] as string[],
            Object.values(TrovePlatform),
          );
        } else {
          checkArrayOption(options[key] as string[], Object.values(Platform));
        }
        break;
    }
    if (!argNoSave.includes(key)) {
      handleOptionDifferences(key, options, savedOptions, optionsToSave);
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
export function isOptionExplicitlySet(key: string, args: string[]): boolean {
  const kebabKey = key.replace(/([A-Z])/g, "-$1").toLowerCase();
  const flags = [`--${key}`, `--${kebabKey}`, `--no-${key}`, `--no-${kebabKey}`];
  const alias = argAlias[key];
  if (alias) {
    if (Array.isArray(alias)) {
      flags.push(...alias.map((a) => (a.length === 1 ? `-${a}` : `--${a}`)));
    } else {
      flags.push(alias.length === 1 ? `-${alias}` : `--${alias}`);
    }
  }

  return args.some((arg) => {
    return flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`));
  });
}

/**
 * Manages differences between CLI-provided options and previously saved options.
 */
function handleOptionDifferences(
  key: string,
  options: Options,
  savedOptions: Options,
  optionsToSave: Partial<Options>,
): void {
  if (options[key] !== undefined) {
    optionsToSave[key] = options[key];
  }
  if (
    Object.hasOwn(savedOptions, key) &&
    !isOptionValueEqual(savedOptions[key], options[key])
  ) {
    if (!isOptionExplicitlySet(key, Deno.args)) {
      // If not explicitly passed on CLI, use the previously saved option
      options[key] = savedOptions[key];
      optionsToSave[key] = savedOptions[key];
    } else {
      // Explicitly passed on CLI, prompt to confirm override
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
    `${key} differs from saved.\n\toriginal: ${JSON.stringify(original)}\n\tnew: ${JSON.stringify(newValue)}\nUse new value (y/N)?`,
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
  const kebab = key.replace(/([A-Z])/g, "-$1").toLowerCase();
  const alias = argAlias[key];
  const shortAlias = Array.isArray(alias)
    ? alias.find((a) => a.length === 1)
    : alias?.length === 1
    ? alias
    : undefined;
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
  console.log(`\n${cyan("Usage:")} humblebundle-ebook-downloader [command] [options]\n`);
  console.log(cyan("Commands:"));
  for (const cmd of Object.values(COMMANDS)) {
    const desc = COMMAND_DESCRIPTIONS[cmd] ?? "";
    console.log(`  ${yellow(cmd.padEnd(16))} ${desc}`);
  }

  console.log(`\n${cyan("Options:")}`);
  for (const [key, desc] of Object.entries(argDescriptions)) {
    const flagStr = getCanonicalFlagLabel(key).padEnd(38);
    const reqBadge = argRequired.includes(key)
      ? `${red("(Required)")} `
      : "";
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
    const kebab = key.replace(/([A-Z])/g, "-$1").toLowerCase();
    longFlags.push(`--${kebab}`);
    if (argBooleans.includes(key)) {
      longFlags.push(`--no-${kebab}`);
    }
    const alias = argAlias[key];
    const list = Array.isArray(alias) ? alias : alias ? [alias] : [];
    for (const a of list) {
      if (a.length === 1) shortFlags.push(`-${a}`);
    }
  }

  const formats = SUPPORTED_FORMATS.join(" ");
  const audioFormats = SUPPORTED_AUDIO_FORMATS.join(" ");
  const platforms = Object.values(Platform).join(" ");
  const qualities = SUPPORTED_VIDEO_QUALITIES.join(" ");

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
      const kebab = key.replace(/([A-Z])/g, "-$1").toLowerCase();
      const desc = rawDesc.split(".")[0].replace(/'/g, "\\'");
      const alias = argAlias[key];
      const short = Array.isArray(alias)
        ? alias.find((a) => a.length === 1)
        : alias?.length === 1
        ? alias
        : undefined;
      const shortPart = short ? ` -s ${short}` : "";
      if (key === "format") {
        lines.push(
          `complete -c ${programName}${shortPart} -l ${kebab} -xa "${formats}" -d '${desc}'`,
        );
      } else if (key === "audioFormat") {
        lines.push(
          `complete -c ${programName}${shortPart} -l ${kebab} -xa "${audioFormats}" -d '${desc}'`,
        );
      } else if (key === "platform") {
        lines.push(
          `complete -c ${programName}${shortPart} -l ${kebab} -xa "${platforms}" -d '${desc}'`,
        );
      } else if (key === "videoQuality") {
        lines.push(
          `complete -c ${programName}${shortPart} -l ${kebab} -xa "${qualities}" -d '${desc}'`,
        );
      } else {
        lines.push(
          `complete -c ${programName}${shortPart} -l ${kebab} -d '${desc}'`,
        );
      }
    }
    return `${lines.join("\n")}\n`;
  }

  if (detected === "zsh") {
    const cmdEntries = commands
      .map((c) => `'${c}:${(COMMAND_DESCRIPTIONS[c] ?? "").replace(/'/g, "")}'`)
      .join(" ");
    const flagEntries = Object.entries(argDescriptions)
      .map(([key, rawDesc]) => {
        const kebab = key.replace(/([A-Z])/g, "-$1").toLowerCase();
        const desc = rawDesc.split(".")[0].replace(/['[\]]/g, "");
        return `'--${kebab}[${desc}]'`;
      })
      .join(" ");
    return `#compdef ${programName}
_${programName.replace(/[^a-zA-Z0-9_]/g, "_")}() {
  local -a commands
  commands=(${cmdEntries})
  if (( CURRENT == 2 )); then
    _describe 'command' commands
  fi
  _arguments ${flagEntries} '--help[Show help]'
}
compdef _${programName.replace(/[^a-zA-Z0-9_]/g, "_")} ${programName}
`;
  }

  // Default: bash
  const allWords = [...commands, ...longFlags, ...shortFlags].join(" ");
  return `# Bash completions for ${programName}
_${programName.replace(/[^a-zA-Z0-9_]/g, "_")}() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  case "\${prev}" in
    -f|--format)
      COMPREPLY=( $(compgen -W "${formats}" -- "\${cur}") )
      return 0
      ;;
    -a|--audio-format)
      COMPREPLY=( $(compgen -W "${audioFormats}" -- "\${cur}") )
      return 0
      ;;
    -p|--platform)
      COMPREPLY=( $(compgen -W "${platforms}" -- "\${cur}") )
      return 0
      ;;
    -q|--video-quality)
      COMPREPLY=( $(compgen -W "${qualities}" -- "\${cur}") )
      return 0
      ;;
    -d|--download-folder|--log-file)
      COMPREPLY=( $(compgen -d -- "\${cur}") )
      return 0
      ;;
  esac
  COMPREPLY=( $(compgen -W "${allWords}" -- "\${cur}") )
}
complete -F _${programName.replace(/[^a-zA-Z0-9_]/g, "_")} ${programName}
`;
}
