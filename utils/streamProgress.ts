import { basename } from "@std/path/basename";
import { MultiBar } from "./progress.ts";
import { formatBytes } from "./formatNumbers.ts";

const streamProgress = {
  start() {
    this.progressBar = this.progress.create(
      this.size,
      this.completed,
      {
        file: this.colour(`${this.operation}: ${basename(this.file)}`),
      },
      formatBytes,
    );

    // Track update time to avoid excessive UI updates
    this.lastUpdate = performance.now();
    this.updateThreshold = 100; // ms between updates
  },
  transform(
    chunk: Uint8Array,
    controller: TransformStreamDefaultController<Uint8Array>,
  ) {
    this.completed += chunk.byteLength;

    // Throttle progress bar updates for better performance
    const now = performance.now();
    if (now - this.lastUpdate > this.updateThreshold) {
      this.progressBar.update(this.completed);
      this.lastUpdate = now;
    }

    // Pass through the chunk without copying
    controller.enqueue(chunk);
  },
  flush() {
    // Final update to ensure accuracy
    this.progressBar.update(this.completed);
    this.progress.remove(this.progressBar);
  },
};

type StreamProgressProps = {
  size: number;
  file: string;
  progress: MultiBar;
  operation: string;
  colour: (text: string) => string;
  completed: number;
  progressBar?: any;
  lastUpdate?: number;
  updateThreshold?: number;
};

export class StreamProgress extends TransformStream<Uint8Array, Uint8Array> {
  constructor(
    size: number,
    file: string,
    progress: MultiBar,
    operation: string,
    colour: (text: string) => string,
  ) {
    super(
      {
        ...streamProgress,
        size,
        file,
        progress,
        operation,
        colour,
        completed: 0,
      } as
        & TransformStreamTransformer<Uint8Array, Uint8Array>
        & StreamProgressProps,
    );
  }
}
