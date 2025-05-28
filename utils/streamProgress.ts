import { basename } from "@std/path/basename";
import type { MultiBar } from "cli-progress";
import { formatFileSize } from "./formatNumbers.ts";

const streamProgress = {
  start() {
    this.progressBar = this.progress.create(
      this.size,
      this.completed,
      {
        file: this.colour(`${this.operation}: ${basename(this.file)}`),
      },
      { formatValue: formatFileSize },
    );

    // Track update time to avoid excessive UI updates
    this.lastUpdate = performance.now();
    this.updateThreshold = 100; // ms between updates
  },
  transform(chunk, controller) {
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

export class StreamProgress extends TransformStream {
  constructor(
    size: number,
    file: string,
    progress: MultiBar,
    operation: string,
    colour: Function,
  ) {
    super({
      ...streamProgress,
      size,
      file,
      progress,
      operation,
      colour,
      completed: 0,
    });
  }
}
