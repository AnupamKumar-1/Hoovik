import { describe, it, expect } from "vitest";
import { createSerialQueue } from "./queue.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createSerialQueue", () => {
  it("never runs tasks concurrently and keeps order", async () => {
    const q = createSerialQueue();
    let active = 0;
    let maxActive = 0;
    const order = [];
    const task = (id) => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await tick();
      order.push(id);
      active--;
      return id;
    };
    const results = await Promise.all([q.enqueue(task(1)), q.enqueue(task(2)), q.enqueue(task(3))]);
    expect(results).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
    expect(maxActive).toBe(1);
  });

  it("a rejected task does not block the next one and still rejects for its caller", async () => {
    const q = createSerialQueue();
    const bad = q.enqueue(async () => { throw new Error("boom"); });
    const good = q.enqueue(async () => "ok");
    await expect(bad).rejects.toThrow("boom");
    await expect(good).resolves.toBe("ok");
  });

  it("a task enqueued later starts only after earlier ones settle", async () => {
    const q = createSerialQueue();
    const log = [];
    const slow = q.enqueue(async () => { await tick(); await tick(); log.push("slow"); });
    const fast = q.enqueue(async () => { log.push("fast"); });
    await Promise.all([slow, fast]);
    expect(log).toEqual(["slow", "fast"]);
  });
});
