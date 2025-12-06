import { basename } from "@std/path/basename";
import { MultiBarWrapper, SingleBarWrapper } from "./progressWrapper.ts";

export class StreamProgress extends TransformStream<Uint8Array, Uint8Array> {
  constructor(
    size: number,
    file: string,
    progress: MultiBarWrapper,
    operation: string,
    colour: (str: string) => string,
  ) {
    let progressBar: SingleBarWrapper;
    let completed = 0;

    super({
      start() {
        progressBar = progress.create(size, 0, {
          file: colour(`${operation}: ${basename(file)}`),
          type: "bytes",
        });
      },
      transform(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) {
        completed += chunk.byteLength;
        progressBar.increment(chunk.byteLength);
        controller.enqueue(chunk);
      },
      flush() {
        progress.remove(progressBar);
      },
    });
  }
}

