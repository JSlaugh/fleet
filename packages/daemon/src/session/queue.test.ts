import { describe, expect, it } from "vitest";
import { MessageQueue } from "./queue.ts";

describe("MessageQueue", () => {
  it("delivers items pushed before iteration (buffered)", async () => {
    const q = new MessageQueue<number>();
    q.push(1);
    q.push(2);
    const it = q[Symbol.asyncIterator]();
    expect(await it.next()).toEqual({ value: 1, done: false });
    expect(await it.next()).toEqual({ value: 2, done: false });
  });

  it("wakes a pending waiter when a value is pushed", async () => {
    const q = new MessageQueue<string>();
    const it = q[Symbol.asyncIterator]();
    const pending = it.next(); // no buffered value → registers a waiter
    q.push("hello");
    expect(await pending).toEqual({ value: "hello", done: false });
  });

  it("close wakes a pending waiter with done", async () => {
    const q = new MessageQueue<number>();
    const it = q[Symbol.asyncIterator]();
    const pending = it.next();
    q.close();
    expect(await pending).toEqual({ value: undefined, done: true });
  });

  it("push after close is a no-op", async () => {
    const q = new MessageQueue<number>();
    q.close();
    q.push(42);
    const it = q[Symbol.asyncIterator]();
    expect(await it.next()).toEqual({ value: undefined, done: true });
  });

  it("drains buffered items before honoring close", async () => {
    const q = new MessageQueue<number>();
    q.push(1);
    q.push(2);
    q.close();
    const it = q[Symbol.asyncIterator]();
    expect(await it.next()).toEqual({ value: 1, done: false });
    expect(await it.next()).toEqual({ value: 2, done: false });
    expect(await it.next()).toEqual({ value: undefined, done: true });
  });

  it("works as an async-iterable in a for-await loop", async () => {
    const q = new MessageQueue<number>();
    q.push(1);
    q.push(2);
    q.close();
    const seen: number[] = [];
    for await (const v of q) seen.push(v);
    expect(seen).toEqual([1, 2]);
  });
});
