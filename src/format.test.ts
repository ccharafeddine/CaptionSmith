import { describe, expect, it } from "vitest";
import { formatPrecise, formatTime } from "./format";

describe("formatTime", () => {
  it("formats m:ss under an hour", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(9.9)).toBe("0:09");
    expect(formatTime(125)).toBe("2:05");
  });

  it("switches to h:mm:ss past an hour", () => {
    expect(formatTime(3600)).toBe("1:00:00");
    expect(formatTime(3725)).toBe("1:02:05");
  });

  it("clamps NaN, infinities, and negatives", () => {
    for (const v of [Number.NaN, Infinity, -1]) expect(formatTime(v)).toBe("0:00");
  });
});

describe("formatPrecise", () => {
  it("keeps one decimal with padded seconds", () => {
    expect(formatPrecise(0)).toBe("0:00.0");
    expect(formatPrecise(5.25)).toBe("0:05.3");
    expect(formatPrecise(61.04)).toBe("1:01.0");
  });

  it("clamps invalid input to zero", () => {
    expect(formatPrecise(-3)).toBe("0:00.0");
    expect(formatPrecise(Number.NaN)).toBe("0:00.0");
  });
});
