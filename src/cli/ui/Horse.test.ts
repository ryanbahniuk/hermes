import { describe, expect, test } from "bun:test";
import { CAPTIONS, GRAZE, GRASS_UNIT, grassLine } from "./Horse";

const FENCE = "||--||--||-";

describe("Horse GRAZE fence", () => {
  test("art has no embedded ground line (grass is rendered separately)", () => {
    expect(GRAZE).toHaveLength(4);
    for (const line of GRAZE) {
      expect(line.includes("~")).toBe(false);
    }
  });

  test("the fence stands to the LEFT of the horse, never to its right", () => {
    const fenceLines = GRAZE.filter((line) => line.includes(FENCE));
    // The fence still appears (on the horse's lower body rows).
    expect(fenceLines.length).toBeGreaterThan(0);
    for (const line of fenceLines) {
      // Fence flush left: the line begins with it.
      expect(line.startsWith(FENCE)).toBe(true);
      // Horse body follows the fence — there is drawing after it, and no second
      // fence trailing to the right.
      const rest = line.slice(FENCE.length);
      expect(rest.trim().length).toBeGreaterThan(0);
      expect(rest.includes(FENCE)).toBe(false);
    }
  });
});

describe("Horse grass", () => {
  test("tiles the unit to exactly the requested width", () => {
    for (const width of [0, 1, 2, 5, 40, 80, 137]) {
      expect(grassLine(width).length).toBe(Math.max(0, width));
    }
  });

  test("repeats the grass unit and never exceeds the width", () => {
    const line = grassLine(80);
    expect(line.startsWith(GRASS_UNIT)).toBe(true);
    expect(line.length).toBe(80);
    // Every character comes from the tile, so it reads as continuous ground.
    for (const ch of line) expect(GRASS_UNIT.includes(ch)).toBe(true);
  });

  test("is responsive: a wider terminal yields a wider ground line", () => {
    expect(grassLine(120).length).toBeGreaterThan(grassLine(60).length);
  });

  test("non-positive widths yield an empty line", () => {
    expect(grassLine(0)).toBe("");
    expect(grassLine(-5)).toBe("");
  });
});

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
