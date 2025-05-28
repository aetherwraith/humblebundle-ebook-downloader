/**
 * A lightweight queue for managing asynchronous operations with concurrency control.
 */
export class Queue {
  private tasks: (() => Promise<unknown>)[] = [];
  private running = 0;
  private concurrency: number;
  private resolveEmpty: (() => void) | null = null;

  /**
   * Creates a new queue with specified concurrency
   * @param concurrency Maximum number of tasks to execute concurrently
   */
  constructor(concurrency: number) {
    this.concurrency = concurrency;
  }

  /**
   * Adds a task to the queue
   * @param task Function that returns a Promise
   */
  add(task: () => Promise<unknown>): void {
    this.tasks.push(task);
    this.processNext();
  }

  /**
   * Processes the next task in the queue if concurrency limit allows
   */
  private processNext(): void {
    if (this.running >= this.concurrency || this.tasks.length === 0) return;

    this.running++;
    const task = this.tasks.shift()!;

    Promise.resolve(task())
      .catch((err) => console.error("Task error:", err))
      .finally(() => {
        this.running--;
        this.processNext();

        if (
          this.running === 0 && this.tasks.length === 0 && this.resolveEmpty
        ) {
          this.resolveEmpty();
          this.resolveEmpty = null;
        }
      });
  }

  /**
   * Returns a promise that resolves when the queue is empty and all tasks have completed
   */
  async done(): Promise<void> {
    if (this.running === 0 && this.tasks.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.resolveEmpty = resolve;
    });
  }

  /**
   * Clears all pending tasks from the queue
   */
  clear(): void {
    this.tasks = [];
  }
}

/**
 * Creates a new queue with specified concurrency
 * @param concurrency Maximum number of tasks to execute concurrently
 */
export function newQueue(concurrency: number): Queue {
  return new Queue(concurrency);
}
