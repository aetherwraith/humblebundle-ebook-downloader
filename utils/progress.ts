/**
 * Progress bar implementation for Deno
 */
import { format } from "@std/fmt/duration";
import { formatPercentage } from "./formatNumbers.ts";

export interface ProgressBarOptions {
  width?: number;
  complete?: string;
  incomplete?: string;
  format?: string;
  clearOnComplete?: boolean;
  hideCursor?: boolean;
}

export class SingleBar {
  private total: number;
  private current: number = 0;
  private readonly width: number;
  private readonly complete: string;
  private readonly incomplete: string;
  private readonly format: string;
  private readonly clearOnComplete: boolean;
  private readonly startTime: number;
  private readonly payload: Record<string, string>;
  private readonly formatFn: (value: number) => string;
  private readonly isMultiBar: boolean;
  private readonly autoRemove: boolean;
  private percentage: number = 0;

  constructor(
    options: ProgressBarOptions = {},
    payload: Record<string, string> = {},
    formatFn: (value: number) => string = (value: number) => value.toString(),
    isMultiBar: boolean = false,
    autoRemove: boolean = false,
  ) {
    this.total = 0;
    this.width = options.width ?? 40;
    this.complete = options.complete ?? "=";
    this.incomplete = options.incomplete ?? "-";
    this.format = options.format ?? " {bar} | {percentage}% | {value}/{total} ";
    this.clearOnComplete = options.clearOnComplete ?? false;
    this.payload = payload;
    this.formatFn = formatFn;
    this.startTime = Date.now();
    this.isMultiBar = isMultiBar;
    this.autoRemove = autoRemove;
  }

  setTotal(total: number): void {
    this.total = total;
    this.render();
  }

  getTotal(): number {
    return this.total;
  }

  update(value: number): void {
    this.current = value;
    this.render();
  }

  increment(value = 1): void {
    this.current += value;
    this.render();
  }

  stop(): void {
    if (this.clearOnComplete) {
      console.log("\u001b[1A\u001b[2K"); // Move up one line and clear it
    }
  }

  shouldRemove(): boolean {
    return this.autoRemove && this.current === this.total;
  }

  private render(): void {
    if (!this.isMultiBar) {
      const output = this.getOutput();

      // Clear line and render
      console.log("\u001b[1A\u001b[2K" + output);
    }
  }

  getOutput() {
    this.percentage = this.total > 0
      ? Math.round((this.current / this.total) * 100)
      : 0;
    const completeLength = Math.round((this.percentage / 100) * this.width);
    const incompleteLength = this.width - completeLength;

    const bar = this.complete.repeat(completeLength) +
      this.incomplete.repeat(incompleteLength);

    const elapsedTime = Date.now() - this.startTime;
    const timePerUnit = this.current > 0 ? elapsedTime / this.current : 0;
    const eta = Math.round(timePerUnit * (this.total - this.current));

    const formatDuration = (ms: number): string => {
      return ms > 0
        ? format(Math.round(ms / 1000) * 1000, {
          ignoreZero: true,
          style: "narrow",
        })
        : "0s";
    };

    const duration_formatted = formatDuration(elapsedTime);
    const eta_formatted = formatDuration(eta);

    let output = this.format;
    output = output.replace("{bar}", bar);
    output = output.replace(
      "{percentage}",
      formatPercentage(this.percentage.toString()),
    );
    output = output.replace("{value}", this.formatFn(this.current));
    output = output.replace("{total}", this.formatFn(this.total));
    output = output.replace("{duration_formatted}", duration_formatted);
    output = output.replace("{eta_formatted}", eta_formatted);

    // Apply payload replacements
    for (const [key, value] of Object.entries(this.payload)) {
      const placeholder = `{${key}}`;
      if (output.includes(placeholder)) {
        output = output.replace(placeholder, value);
      }
    }
    return output;
  }
}

interface CreateParams {
  total: number;
  startValue: number;
  payload?: Record<string, string>;
  formatFn?: (value: number) => string;
  autoRemove?: boolean;
}

export class MultiBar {
  private bars: SingleBar[] = [];
  private readonly options: ProgressBarOptions;
  private renderInterval: number | null = null;
  private maxBars: number = 0;
  private firstRender: boolean = true;

  constructor(options: ProgressBarOptions = {}) {
    this.options = options;
    this.renderInterval = setInterval(
      () => this.render(),
      100,
    ) as unknown as number;
  }

  create(
    { total, startValue, payload = {}, formatFn, autoRemove = false }:
      CreateParams,
  ): SingleBar {
    const bar = new SingleBar(
      this.options,
      payload,
      formatFn,
      true,
      autoRemove,
    );
    bar.setTotal(total);
    if (startValue > 0) {
      bar.update(startValue);
    }
    this.bars.push(bar);
    if (this.bars.length > this.maxBars) {
      this.maxBars = this.bars.length;
    }
    return bar;
  }

  remove(bar: SingleBar): void {
    const index = this.bars.indexOf(bar);
    if (index !== -1) {
      this.bars.splice(index, 1);
    }
  }

  log(message: string): void {
    let output = "\u001b[1A\u001b[2K".repeat(this.bars.length ? this.maxBars : 0);
    output = output + this.bars.length + ":" + this.maxBars + " bob " + message + "\n";
    for (const bar of this.bars) {
      const barOutput = bar.getOutput();
      if (bar.shouldRemove()) {
        this.remove(bar);
        continue;
      }
      if (barOutput.trim().length > 0) {
        output = output + bar.getOutput() + "\n";
      }
    }

    console.log(this.maxBars > 0 ? output.slice(0, -1) : output);
  }

  stop(): void {
    if (this.renderInterval !== null) {
      clearInterval(this.renderInterval);
      this.renderInterval = null;
    }
    this.bars = [];
  }

  private render(): void {
    let output = "";
    if (this.firstRender) {
      this.firstRender = false;
    } else {
      output = "\u001b[1A\u001b[2K".repeat(this.maxBars);
    }
    for (const bar of this.bars) {
      const barOutput = bar.getOutput();
      if (bar.shouldRemove()) {
        this.remove(bar);
        continue;
      }
      if (barOutput.trim().length > 0) {
        output = output + bar.getOutput() + "\n";
      }
    }

    console.log(output.slice(0, -1));
  }
}

// Shades classic preset
export const ShadesClassicPreset = {
  format:
    ' {bar} | {percentage}% | {duration_formatted}/{eta_formatted} | {value}/{total} | "{file}" ',
  complete: "█",
  incomplete: "░",
  width: 40,
  clearOnComplete: true,
  hideCursor: true,
};
