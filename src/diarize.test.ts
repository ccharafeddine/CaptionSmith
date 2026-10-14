import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const d = await import("./diarize");

describe("speaker labels and colors", () => {
  beforeEach(() => {
    d.resetDiarization();
  });

  it("defaults to 1-based Speaker N", () => {
    expect(d.speakerLabel(0)).toBe("Speaker 1");
    expect(d.speakerLabel(4)).toBe("Speaker 5");
  });

  it("uses a custom name, falling back when it is blank", () => {
    d.renameSpeaker(0, "  Ana ");
    expect(d.speakerLabel(0)).toBe("Ana");
    d.renameSpeaker(0, "   ");
    expect(d.speakerLabel(0)).toBe("Speaker 1");
  });

  it("reset clears custom names", () => {
    d.renameSpeaker(1, "Bo");
    d.resetDiarization();
    expect(d.speakerLabel(1)).toBe("Speaker 2");
  });

  it("cycles the palette and keeps the Smith accents first", () => {
    expect(d.speakerColor(0)).toBe("#45f2f2");
    expect(d.speakerColor(1)).toBe("#a974ff");
    expect(d.speakerColor(8)).toBe(d.speakerColor(0));
  });
});
