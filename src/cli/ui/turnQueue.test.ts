import { describe, expect, test } from "bun:test";
import { createTurnQueue } from "./turnQueue";

// Lets microtasks (the drain loop's awaited continuations) settle between assertions.
const flush = () => new Promise((r) => setTimeout(r, 0));

// A runTurn stub whose turns hang until we explicitly resolve them, so tests can
// observe exactly which turn is in flight at each step.
function controllable() {
  const started: string[] = [];
  let resolveCurrent: (() => void) | null = null;
  const runTurn = (text: string) =>
    new Promise<void>((resolve) => {
      started.push(text);
      resolveCurrent = resolve;
    });
  const finishCurrent = () => {
    const r = resolveCurrent!;
    resolveCurrent = null;
    r();
  };
  return { runTurn, started, finishCurrent };
}

describe("createTurnQueue", () => {
  test("a submission mid-turn is queued, not run concurrently", async () => {
    const { runTurn, started } = controllable();
    const q = createTurnQueue({ runTurn });

    q.submit("a"); // starts immediately
    q.submit("b"); // 'a' is in flight → queued
    q.submit("c"); // still in flight → queued
    await flush();

    // Only one turn ever ran; the rest wait in FIFO order.
    expect(started).toEqual(["a"]);
    expect(q.pending()).toEqual(["b", "c"]);
  });

  test("the queue drains in order after each turn completes", async () => {
    const { runTurn, started, finishCurrent } = controllable();
    const q = createTurnQueue({ runTurn });

    q.submit("a");
    q.submit("b");
    q.submit("c");
    await flush();
    expect(started).toEqual(["a"]);
    expect(q.pending()).toEqual(["b", "c"]);

    finishCurrent(); // a done → b starts
    await flush();
    expect(started).toEqual(["a", "b"]);
    expect(q.pending()).toEqual(["c"]);

    finishCurrent(); // b done → c starts
    await flush();
    expect(started).toEqual(["a", "b", "c"]);
    expect(q.pending()).toEqual([]);

    finishCurrent(); // c done → loop ends, nothing lost or duplicated
    await flush();
    expect(started).toEqual(["a", "b", "c"]);
    expect(q.pending()).toEqual([]);
  });

  test("submitting after the queue drains starts a fresh loop", async () => {
    const { runTurn, started, finishCurrent } = controllable();
    const q = createTurnQueue({ runTurn });

    q.submit("a");
    await flush();
    finishCurrent(); // queue now empty, loop exited
    await flush();
    expect(started).toEqual(["a"]);

    q.submit("b"); // must re-arm the drain loop
    await flush();
    expect(started).toEqual(["a", "b"]);
  });

  test("onChange reports the pending list as it grows and drains", async () => {
    const { runTurn, finishCurrent } = controllable();
    const snapshots: string[][] = [];
    const q = createTurnQueue({ runTurn, onChange: (p) => snapshots.push(p) });

    q.submit("a"); // enqueue a, then drain dequeues it
    q.submit("b");
    q.submit("c");
    await flush();
    expect(q.pending()).toEqual(["b", "c"]);

    finishCurrent();
    await flush();
    expect(q.pending()).toEqual(["c"]);

    // Every notification is an independent snapshot (no shared mutable array).
    expect(snapshots.some((s) => s.length === 2)).toBe(true);
    expect(snapshots.at(-1)).toEqual(["c"]);
  });
});
