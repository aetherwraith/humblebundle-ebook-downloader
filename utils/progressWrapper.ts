import { dirname, resolve } from "@std/path";
import { formatFileSize, formatTime } from "./formatNumbers.ts";
import { stripAnsi } from "./generic.ts";

/**
 * Payload options for a progress bar.
 */
interface Payload {
  file?: string;
  type?: "bytes" | "number";
  [key: string]: unknown;
}

const ESC = "\x1b";
const CSI = `${ESC}[`;
const MOVE_UP = (n: number) => `${CSI}${n}A`;
const CLEAR_LINE = `${CSI}2K`; // Clear entire line
const MOVE_LEFT = `${CSI}1G`; // Move to column 1
const textEncoder = new TextEncoder();

/**
 * Custom wrapper for managing multiple terminal progress bars simultaneously
 * without external Curses/ANSI dependencies.
 */
export class MultiBarWrapper {
  private bars: SingleBarWrapper[] = [];
  private lastLineCount = 0;
  private lastRender = 0;
  private renderTimeout: ReturnType<typeof setTimeout> | undefined;
  private readonly isTerminal = Deno.stdout.isTerminal();
  private summaryText?: string;
  private verbose = false;
  private quietTerminal = false;
  private logFilePath?: string;
  private logDirEnsured = false;
  private logBuffer: string[] = [];
  private logFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private cachedColumns = 80;
  private lastColumnsCheck = 0;

  // Store original console methods
  private originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
  };

  constructor(
    options: {
      verbose?: boolean;
      quietTerminal?: boolean;
      logFilePath?: string;
    } = {},
  ) {
    if (options.verbose !== undefined) {
      this.verbose = Boolean(options.verbose);
    }
    if (options.quietTerminal !== undefined) {
      this.quietTerminal = Boolean(options.quietTerminal);
    }
    if (options.logFilePath) {
      this.logFilePath = resolve(options.logFilePath);
    }

    // Patch console methods to route through this.log
    const patch = (method: "log" | "warn" | "error" | "info") => {
      console[method] = (...args: unknown[]) => {
        this.log(...args);
      };
    };

    patch("log");
    patch("warn");
    patch("error");
    patch("info");
  }

  /**
   * Configures verbose console output and file logging destination.
   */
  configureLogger(config: { verbose?: boolean; logFilePath?: string }) {
    if (config.verbose !== undefined) {
      this.verbose = config.verbose;
    }
    if (config.logFilePath !== undefined) {
      this.flushLogs();
      this.logFilePath = config.logFilePath
        ? resolve(config.logFilePath)
        : undefined;
      this.logDirEnsured = false;
    }
  }

  /**
   * Flushes any buffered log entries synchronously to `logFilePath`.
   */
  flushLogs() {
    if (this.logFlushTimer) {
      clearTimeout(this.logFlushTimer);
      this.logFlushTimer = undefined;
    }
    if (!this.logFilePath || this.logBuffer.length === 0) {
      this.logBuffer = [];
      return;
    }
    const payload = this.logBuffer.join("");
    this.logBuffer = [];
    try {
      if (!this.logDirEnsured) {
        Deno.mkdirSync(dirname(this.logFilePath), { recursive: true });
        try {
          const st = Deno.statSync(this.logFilePath);
          if (st.isFile && st.size > 5 * 1024 * 1024) {
            Deno.renameSync(this.logFilePath, `${this.logFilePath}.1`);
          }
        } catch {
          // Log file does not exist yet
        }
        this.logDirEnsured = true;
      }
      Deno.writeTextFileSync(this.logFilePath, payload, {
        append: true,
        create: true,
      });
    } catch {
      // Ignore file log errors so downloads are never interrupted
    }
  }

  private writeToFile(level: "INFO" | "DEBUG", message: string) {
    if (!this.logFilePath) return;
    const cleanMsg = stripAnsi(message);
    const line = `[${new Date().toISOString()}] [${level}] ${cleanMsg}\n`;
    this.logBuffer.push(line);
    if (this.logBuffer.length >= 50) {
      this.flushLogs();
    } else if (!this.logFlushTimer) {
      this.logFlushTimer = setTimeout(() => {
        this.logFlushTimer = undefined;
        this.flushLogs();
      }, 150);
    }
  }

  create(
    total: number,
    startValue: number,
    payload: Payload = {},
  ): SingleBarWrapper {
    const bar = new SingleBarWrapper(this, total, startValue, payload);
    this.bars.push(bar);
    this.render(true);
    return bar;
  }

  remove(bar: SingleBarWrapper) {
    const index = this.bars.indexOf(bar);
    if (index > -1) {
      this.bars.splice(index, 1);
      this.render(true);
    }
  }

  setSummary(text?: string) {
    this.summaryText = text;
    this.render();
  }

  private printTerminalLine(joined: string) {
    this.clearBars();
    this.originalConsole.log(joined);
    this.lastLineCount = 0;
    this.render(true);
  }

  log(...messages: unknown[]) {
    const joined = messages.join(" ");
    this.writeToFile("INFO", joined);
    if (this.quietTerminal) return;
    this.printTerminalLine(joined);
  }

  /**
   * Logs diagnostic/debug messages to the log file, and only prints to the terminal
   * when `--verbose` (`-v`) is enabled.
   */
  debug(...messages: unknown[]) {
    const joined = messages.join(" ");
    this.writeToFile("DEBUG", joined);
    if (this.verbose && !this.quietTerminal) {
      this.printTerminalLine(joined);
    }
  }

  stop() {
    if (this.renderTimeout) {
      clearTimeout(this.renderTimeout);
      this.renderTimeout = undefined;
    }

    this.flushLogs();

    // Restore console methods
    console.log = this.originalConsole.log;
    console.warn = this.originalConsole.warn;
    console.error = this.originalConsole.error;
    console.info = this.originalConsole.info;

    // Ensure one final render to show 100%
    this.doRender();
  }

  private clearBars() {
    if (this.lastLineCount > 0 && this.isTerminal) {
      let output = MOVE_UP(this.lastLineCount);
      for (let i = 0; i < this.lastLineCount; i++) {
        output += `${CLEAR_LINE}\n`;
      }
      output += MOVE_UP(this.lastLineCount);
      Deno.stdout.writeSync(textEncoder.encode(output));
    }
  }

  render(force = false) {
    const now = Date.now();
    const elapsed = now - this.lastRender;
    if (!force && elapsed < 100) {
      if (!this.renderTimeout) {
        this.renderTimeout = setTimeout(() => {
          this.renderTimeout = undefined;
          this.render();
        }, Math.max(1, 100 - elapsed));
      }
      return;
    }

    if (this.renderTimeout) {
      clearTimeout(this.renderTimeout);
      this.renderTimeout = undefined;
    }

    this.lastRender = now;
    this.doRender();
  }

  private doRender() {
    if (this.quietTerminal || !this.isTerminal) {
      return;
    }

    let output = "";

    // 1. Move cursor up and clear based on last render
    if (this.lastLineCount > 0) {
      output += MOVE_UP(this.lastLineCount);
    }

    const lines: string[] = [];
    const now = Date.now();
    if (now - this.lastColumnsCheck > 1000) {
      this.lastColumnsCheck = now;
      try {
        this.cachedColumns = Deno.consoleSize().columns || 80;
      } catch {
        this.cachedColumns = 80;
      }
    }
    const columns = this.cachedColumns;

    for (const bar of this.bars) {
      lines.push(bar.renderString(columns));
    }
    if (this.summaryText) {
      lines.push(this.summaryText.slice(0, Math.max(20, columns - 1)));
    }

    // Print new lines
    for (const line of lines) {
      output += `${CLEAR_LINE}${MOVE_LEFT}${line}\n`;
    }

    // If we have fewer lines than before, clear the leftovers
    if (lines.length < this.lastLineCount) {
      for (let i = lines.length; i < this.lastLineCount; i++) {
        output += `${CLEAR_LINE}\n`;
      }
      const diff = this.lastLineCount - lines.length;
      if (diff > 0) {
        output += MOVE_UP(diff);
      }
    }

    if (output) {
      Deno.stdout.writeSync(textEncoder.encode(output));
    }

    this.lastLineCount = lines.length;
  }
}

/**
 * Represents an individual progress bar within a MultiBarWrapper.
 */
export class SingleBarWrapper {
  private parent: MultiBarWrapper;
  private total: number;
  private value: number;
  private payload: Payload;
  private startTime: number;

  constructor(
    parent: MultiBarWrapper,
    total: number,
    startValue: number,
    payload: Payload,
  ) {
    this.parent = parent;
    this.total = total;
    this.value = startValue;
    this.payload = payload;
    this.startTime = Date.now();
  }

  /**
   * Increments the current progress value by amount.
   */
  increment(amount: number = 1, payload?: Payload) {
    this.value += amount;
    if (payload) {
      this.payload = { ...this.payload, ...payload };
    }
    this.parent.render();
  }

  /**
   * Sets the current progress value directly.
   */
  update(value: number, payload?: Payload) {
    this.value = value;
    if (payload) {
      this.payload = { ...this.payload, ...payload };
    }
    this.parent.render();
  }

  /**
   * Updates the total value for this progress bar.
   */
  setTotal(total: number) {
    this.total = total;
    this.parent.render();
  }

  /**
   * Returns the total target value.
   */
  getTotal(): number {
    return this.total;
  }

  /**
   * Returns the current progress value.
   */
  getValue(): number {
    return this.value;
  }

  stop() {}

  // Renamed to renderString for manual rendering
  renderString(width: number): string {
    const now = Date.now();
    const rawElapsed = (now - this.startTime) / 1000;
    const elapsedSeconds = Math.max(rawElapsed, 0.001);

    // Calculate rate and ETA
    let etaSeconds = 0;
    if (this.value > 0 && this.total > 0) {
      const rate = this.value / elapsedSeconds;
      const remaining = Math.max(0, this.total - this.value);
      etaSeconds = remaining / rate;
    }

    // Format Times
    const elapsedStr = formatTime(rawElapsed);
    const etaStr = (this.value > 0) ? formatTime(etaSeconds) : "--:--";

    const pct = this.total > 0 ? this.value / this.total : 0;
    const percent = Math.min(Math.max(pct * 100, 0), 100).toFixed(2).padStart(
      6,
      " ",
    );

    const type = this.payload.type || "number";
    let stats = "";
    if (type === "bytes") {
      const formattedCompleted = formatFileSize(this.value.toString(), {}, "");
      const formattedTotal = formatFileSize(this.total.toString(), {}, "");
      const speed = elapsedSeconds > 0
        ? `${
          formatFileSize(
            Math.round(this.value / elapsedSeconds).toString(),
            {},
            "",
          )
        }/s`
        : "0 B/s";
      stats = `${formattedCompleted}/${formattedTotal} (${speed})`;
    } else {
      stats = `${this.value}/${this.total}`;
    }

    let text = "";
    if (this.payload.file) {
      text += ` "${this.payload.file}"`;
    }

    // Bar drawing
    // [======    ] 100% | 00:12/00:24 | 10MB/20MB | "file"
    // Available space (use visible width without ANSI color codes)
    const template =
      ` ${percent}% | ${elapsedStr}/${etaStr} | ${stats} |${text}`;
    const visibleTemplateLen = stripAnsi(template).length;
    const barWidth = Math.max(width - visibleTemplateLen - 4, 10); // reserve space
    const filled = Math.round(barWidth * (Math.min(pct, 1)));
    const empty = barWidth - filled;

    const barStr = `[${"=".repeat(filled)}${" ".repeat(empty)}]`;

    return `${barStr}${template}`;
  }
}

/**
 * Logs diagnostic messages via `progress.debug` when available, falling back to `progress.log`
 * (for lightweight test mocks that only implement `log`).
 */
export function progressDebug(
  progress: MultiBarWrapper | undefined,
  ...args: unknown[]
): void {
  if (!progress) return;
  if (typeof progress.debug === "function") {
    progress.debug(...args);
  } else {
    progress.log(...args);
  }
}
