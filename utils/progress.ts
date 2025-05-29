/**
 * Progress bar implementation for Deno
 */

import { gray } from "@std/fmt/colors";
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

export interface MultiBarOptions extends ProgressBarOptions {
  autopadding?: boolean;
}

export class SingleBar {
  private total: number;
  private current: number = 0;
  private width: number;
  private complete: string;
  private incomplete: string;
  private format: string;
  private clearOnComplete: boolean;
  private startTime: number;
  private payload: Record<string, string>;
  private formatFn: (value: number) => string;
  private isMultiBar: boolean;

  constructor(
    options: ProgressBarOptions = {},
    payload: Record<string, string> = {},
    formatFn: (value: number) => string = (value: number) => value.toString(),
    isMultiBar = false,
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

  private render(): void {
    if (!this.isMultiBar) {
      const output = this.getOutput();

      // Clear line and render
      console.log("\u001b[1A\u001b[2K" + output);
    }
  }

  getOutput() {
    const percentage = this.total > 0
      ? Math.round((this.current / this.total) * 100)
      : 0;
    const completeLength = Math.round((percentage / 100) * this.width);
    const incompleteLength = this.width - completeLength;

    const bar = this.complete.repeat(completeLength) +
      this.incomplete.repeat(incompleteLength);

    const elapsedTime = Date.now() - this.startTime;
    const timePerUnit = this.current > 0 ? elapsedTime / this.current : 0;
    const eta = Math.round(timePerUnit * (this.total - this.current));

    const formatDuration = (ms: number): string => {
      return ms > 0 ? format(ms, { ignoreZero: true, style: "narrow" }) : "0s";
    };

    const duration_formatted = formatDuration(elapsedTime);
    const eta_formatted = formatDuration(eta);

    let output = this.format;
    output = output.replace("{bar}", bar);
    output = output.replace(
      "{percentage}",
      formatPercentage(percentage.toString()),
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

export class MultiBar {
  private bars: SingleBar[] = [];
  private options: MultiBarOptions;
  private logLines: string[] = [];
  private renderInterval: number | null = null;

  constructor(options: MultiBarOptions = {}) {
    this.options = options;
    this.renderInterval = setInterval(
      () => this.render(),
      1000,
    ) as unknown as number;
  }

  create(
    total: number,
    startValue: number,
    payload: Record<string, string> = {},
    formatFn: (value: number) => string = (value: number) => value.toString(),
  ): SingleBar {
    const bar = new SingleBar(this.options, payload, formatFn, true);
    bar.setTotal(total);
    if (startValue > 0) {
      bar.update(startValue);
    }
    this.bars.push(bar);
    console.log(""); // Add a line for each new bar
    return bar;
  }

  remove(bar: SingleBar): void {
    const index = this.bars.indexOf(bar);
    if (index !== -1) {
      this.bars.splice(index, 1);
    }
  }

  log(message: string): void {
    this.logLines.push(message);
    console.log(gray(message));
  }

  stop(): void {
    if (this.renderInterval !== null) {
      clearInterval(this.renderInterval);
      this.renderInterval = null;
    }
    for (const bar of this.bars) {
      bar.stop();
    }
    this.bars = [];
  }

  private render(): void {
    // for (let i = 1; i <= this.bars.length; i++) {
    //   console.log("\u001b[1A\u001b[2K");
    // }

    let output = "";

    for (const _ of this.bars) {
      output += "\u001b[1A\u001b[2K"
    }

    for (const bar of this.bars) {
      output += bar.getOutput() + "\n";
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
