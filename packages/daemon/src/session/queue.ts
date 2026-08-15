export class MessageQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private waiter?: (result: IteratorResult<T>) => void;
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({ value, done: false });
    } else {
      this.buffer.push(value);
    }
  }

  close(): void {
    this.closed = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const buffered = this.buffer.shift();
        if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}
