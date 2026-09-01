import { describe, expect, test } from "bun:test";
import { lineRows, textRows, type Line } from "./ChatView";

// These height estimators are what keep the transcript from emitting more wrapped
// rows than the terminal has — the overflow that makes Ink ghost old frames over
// new ones (garbled, overlaid planner text). They must count *wrapped* rows, not
// logical lines, and never undercount so badly that the viewport overflows.
describe("textRows", () => {
  test("short text is a single row", () => {
    expect(textRows("hello", 80)).toBe(1);
  });

  test("a line longer than the width wraps to multiple rows", () => {
    expect(textRows("x".repeat(200), 80)).toBe(3); // ceil(200 / 80)
  });

  test("each embedded newline starts a new row", () => {
    expect(textRows("a\nb\nc", 80)).toBe(3);
  });

  test("wrapping is summed per hard-wrapped segment", () => {
    // 100-char segment (2 rows) + short segment (1 row)
    expect(textRows("x".repeat(100) + "\nshort", 80)).toBe(3);
  });

  test("degenerate width never returns zero", () => {
    expect(textRows("anything", 0)).toBe(1);
  });
});

describe("lineRows", () => {
  test("assistant lines account for the 'planner › ' prefix", () => {
    // 74 chars of body + 10-char prefix = 84 > 80, so it wraps to 2 rows.
    const line: Line = { id: "a", kind: "assistant", text: "y".repeat(74) };
    expect(lineRows(line, 80)).toBe(2);
    // One char shorter fits on a single row.
    expect(lineRows({ id: "a", kind: "assistant", text: "y".repeat(70) }, 80)).toBe(1);
  });

  test("user lines reserve the blank row rendered above them", () => {
    expect(lineRows({ id: "u", kind: "user", text: "hi" }, 80)).toBe(2); // 1 text + 1 blank
  });

  test("runs/prs lists count one row per item, at least one", () => {
    expect(lineRows({ id: "r", kind: "runs", runs: [] }, 80)).toBe(1);
    expect(lineRows({ id: "p", kind: "prs", prs: [] }, 80)).toBe(1);
  });
});
