import { basename } from "@std/path/basename";
import { formatFileSize } from "./formatNumbers.ts";


const streamProgress = {
  start() {
    this.checksumBar = this.progress.create(
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
    this.checksumBar.increment(chunk.byteLength);
    controller.enqueue(chunk);
  },
  flush() {
    this.progress.remove(this.checksumBar);
  },
};

export class StreamProgress extends TransformStream {
  constructor(
    size: number,
    file: string,
    progress: unknown,
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
