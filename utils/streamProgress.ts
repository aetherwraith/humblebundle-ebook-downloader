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
  },
  transform(chunk, controller) {
    this.completed += chunk.byteLength;
    this.progressBar.increment(chunk.byteLength);
    controller.enqueue(chunk);
  },
  flush() {
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
