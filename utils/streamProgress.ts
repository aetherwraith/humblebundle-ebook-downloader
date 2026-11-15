import { basename } from "@std/path/basename";
import { MultiBarWrapper, SingleBarWrapper } from "./progressWrapper.ts";

/**
 * Shared virtual-time bandwidth rate limiter that paces concurrent download streams
 * so total throughput across all active workers stays within `bytesPerSecond`.
 */
export class BandwidthLimiter {
  private bytesPerSecond: number;
  private nextAvailableMs = 0;

  constructor(bytesPerSecond = 0) {
    this.bytesPerSecond = bytesPerSecond;
  }

  setRate(bytesPerSecond = 0) {
    this.bytesPerSecond = bytesPerSecond;
    this.nextAvailableMs = 0;
  }

  getRate(): number {
    return this.bytesPerSecond;
  }

  async consume(bytes: number, signal?: AbortSignal): Promise<void> {
    if (this.bytesPerSecond <= 0 || bytes <= 0 || signal?.aborted) return;
    const now = Date.now();
    const durationMs = (bytes / this.bytesPerSecond) * 1000;
    const startAt = Math.max(now, this.nextAvailableMs);
    this.nextAvailableMs = startAt + durationMs;
    const waitMs = startAt - now;
    if (waitMs > 5) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, waitMs);
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
}

export const globalBandwidthLimiter = new BandwidthLimiter(0);

/**
 * TransformStream that passes through Uint8Array chunks while tracking
 * bytes transferred on an active progress bar and optionally applying bandwidth rate limiting.
 */
export class StreamProgress extends TransformStream<Uint8Array, Uint8Array> {
  constructor(
    size: number,
    file: string,
    progress: MultiBarWrapper,
    operation: string,
    colour: (str: string) => string,
    limiter?: BandwidthLimiter,
  ) {
    let progressBar: SingleBarWrapper;

    super({
      start() {
        progressBar = progress.create(size, 0, {
          file: colour(`${operation}: ${basename(file)}`),
          type: "bytes",
        });
      },
      async transform(
        chunk: Uint8Array,
        controller: TransformStreamDefaultController<Uint8Array>,
      ) {
        if (limiter) {
          await limiter.consume(chunk.byteLength);
        }
        progressBar.increment(chunk.byteLength);
        controller.enqueue(chunk);
      },
      flush() {
        progress.remove(progressBar);
      },
    });
  }
}
