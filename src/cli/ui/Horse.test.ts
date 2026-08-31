import { describe, expect, test } from "bun:test";
import { CAPTIONS } from "./Horse";

describe("Horse CAPTIONS", () => {
  test("has 32 phrases", () => {
    expect(CAPTIONS).toHaveLength(32);
  });

  test("every phrase is a non-empty lowercase western line ending in an ellipsis", () => {
    for (const c of CAPTIONS) {
      expect(c.length).toBeGreaterThan(0);
      expect(c.endsWith("…")).toBe(true);
      // Lowercase tone: no uppercase letters.
      expect(c).toBe(c.toLowerCase());
    }
  });

  test("phrases are unique", () => {
    expect(new Set(CAPTIONS).size).toBe(CAPTIONS.length);
  });

  test("keeps the original seven phrases", () => {
    for (const original of [
      "wranglin' workers…",
      "saddlin' up…",
      "roundin' up the herd…",
      "gallopin'…",
      "headin' to town…",
      "hitchin' the wagon…",
      "kickin' up dust…",
    ]) {
      expect(CAPTIONS).toContain(original);
    }
  });
});
