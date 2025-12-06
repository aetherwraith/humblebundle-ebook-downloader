import { formatFileSize, formatTime } from "./formatNumbers.ts";

// Define a type for the payload to avoid 'any'
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

export class MultiBarWrapper {
  private bars: SingleBarWrapper[] = [];
  private lastLineCount = 0;
  private lastRender = 0;
  private renderTimeout: number | undefined;
  private renderPromise: Promise<void> = Promise.resolve();

  constructor(_options: { clearOnComplete?: boolean; format?: string; [key: string]: unknown }) {
      // Options are largely ignored in manual implementation for simplicity, 
      // or can be used to customize the manual render string.
  }

  create(total: number, startValue: number, payload: Payload = {}): SingleBarWrapper {
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

  log(...messages: unknown[]) {
    // Clear current bars
    this.clearBars();
    // Log message
    console.log(messages.join(" "));
    // Reset line count since we are now at a "fresh" line
    this.lastLineCount = 0;
    // Re-render
    this.render(true);
  }

  stop() {
    // When done, we might want to leave the bars on screen or clear them?
    // Usually keep them.
    // Ensure one final render to show 100%
    this.render(true);
  }

  private clearBars() {
      if (this.lastLineCount > 0) {
          Deno.stdout.writeSync(new TextEncoder().encode(MOVE_UP(this.lastLineCount)));
          for (let i = 0; i < this.lastLineCount; i++) {
              Deno.stdout.writeSync(new TextEncoder().encode(`${CLEAR_LINE}\n`));
          }
           Deno.stdout.writeSync(new TextEncoder().encode(MOVE_UP(this.lastLineCount)));
      }
  }

  async render(force = false) {
    const now = Date.now();
    if (!force && now - this.lastRender < 100) {
      if (!this.renderTimeout) {
        this.renderTimeout = setTimeout(() => {
          this.renderTimeout = undefined;
          this.render();
        }, 100);
      }
      return;
    }
    
    if (this.renderTimeout) {
      clearTimeout(this.renderTimeout);
      this.renderTimeout = undefined;
    }
    
    this.lastRender = now;
    
    // Serialized render
    this.renderPromise = this.renderPromise.then(async () => {
         this.doRender();
         await Promise.resolve();
    });
    
    await this.renderPromise;
  }

  private doRender() {
      // 1. Move cursor up and clear based on last render
      if (this.lastLineCount > 0) {
        // Move up N lines
        const up = MOVE_UP(this.lastLineCount);
        Deno.stdout.writeSync(new TextEncoder().encode(up));
      }

      const lines: string[] = [];
      const columns = 80; // Hardcode width or detect via Deno.consoleSize() if unstable? Deno.consoleSize might fail in some envs.

      for (const bar of this.bars) {
          const rendered = bar.renderString(columns);
          lines.push(rendered);
      }

      // Print new lines
      for (const line of lines) {
          // Clear line before printing to handle shrinking content (though we usually overwrite)
          Deno.stdout.writeSync(new TextEncoder().encode(`${CLEAR_LINE}${MOVE_LEFT}${line}\n`));
      }

      // If we have fewer lines than before, clear the leftovers
      if (lines.length < this.lastLineCount) {
          for (let i = lines.length; i < this.lastLineCount; i++) {
               Deno.stdout.writeSync(new TextEncoder().encode(`${CLEAR_LINE}\n`));
          }
           // Move cursor back up if we just cleared empty lines?
           // Actually, if we printed N lines, we are at line N+1.
           // If we cleared M extra lines, we are at N+1+M.
           // We typically want the cursor to remain at the bottom of the *active* bars (or below them).
           // If we cleared extra lines, we should probably move back up to the bottom of the valid bars.
           const diff = this.lastLineCount - lines.length;
           if (diff > 0) {
               Deno.stdout.writeSync(new TextEncoder().encode(MOVE_UP(diff)));
           }
      }

      this.lastLineCount = lines.length;
  }
}





export class SingleBarWrapper {
  private parent: MultiBarWrapper;
  private total: number;
  private value: number;
  private payload: Payload;
  private startTime: number;

  constructor(parent: MultiBarWrapper, total: number, startValue: number, payload: Payload) {
    this.parent = parent;
    this.total = total;
    this.value = startValue;
    this.payload = payload;
    this.startTime = Date.now();
  }

  // ... (increment, update, setTotal, getTotal, getValue, stop remain same)
  increment(amount: number = 1, payload?: Payload) {
    this.value += amount;
    if (payload) {
      this.payload = { ...this.payload, ...payload };
    }
    this.parent.render();
  }
  
  update(value: number, payload?: Payload) {
      this.value = value;
      if (payload) {
        this.payload = { ...this.payload, ...payload };
      }
      this.parent.render();
  }

  setTotal(total: number) {
    this.total = total;
    this.parent.render();
  }

  getTotal(): number {
    return this.total;
  }
  
  getValue(): number {
    return this.value;
  }
  
  stop() {}

  // Renamed to renderString for manual rendering
  renderString(width: number): string {
    const now = Date.now();
    const elapsedSeconds = (now - this.startTime) / 1000;
    
    // Calculate rate and ETA
    let etaSeconds = 0;
    if (this.value > 0 && this.total > 0) {
        const rate = this.value / elapsedSeconds;
        const remaining = Math.max(0, this.total - this.value);
        etaSeconds = remaining / rate;
    }
    
    // Format Times
    const elapsedStr = formatTime(elapsedSeconds);
    const etaStr = (this.value > 0) ? formatTime(etaSeconds) : "--:--";

    const pct = this.total > 0 ? this.value / this.total : 0;
    const percent = Math.min(Math.max(pct * 100, 0), 100).toFixed(2);
    
    const type = this.payload.type || "number";
    let stats = "";
    if (type === "bytes") {
        const formattedCompleted = formatFileSize(this.value.toString(), {}, "");
        const formattedTotal = formatFileSize(this.total.toString(), {}, "");
        stats = `${formattedCompleted}/${formattedTotal}`;
    } else {
        stats = `${this.value}/${this.total}`;
    }

    let text = "";
    if (this.payload.file) {
      text += ` "${this.payload.file}"`;
    }

    // Bar drawing
    // [======    ] 100% | 00:12/00:24 | 10MB/20MB | "file"
    // Available space
    const template = ` ${percent}% | ${elapsedStr}/${etaStr} | ${stats} |${text}`;
    const barWidth = Math.max(width - template.length - 4, 10); // reserve space
    const filled = Math.round(barWidth * (Math.min(pct, 1)));
    const empty = barWidth - filled;
    
    const barStr = `[${"=".repeat(filled)}${" ".repeat(empty)}]`;
    
    return `${barStr}${template}`;
  }

  // Kept for backward compat
  getRenderOptions() { 
      return {}; 
  }
}
