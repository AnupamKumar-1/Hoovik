// Strict serial execution. Part 1 found that a new on-device request destroys in-flight sessions
// (the SDK creates a fresh session per call and destroys the previous one), so on-device calls
// must never overlap. A failed task never blocks the next one.

export function createSerialQueue() {
  let tail = Promise.resolve();
  return {
    enqueue(task) {
      const run = tail.then(() => task());
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}
