import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const b = await import("./batch");

describe("batch queue", () => {
  beforeEach(() => {
    b.clearBatch();
  });

  it("adds files with their base names, Windows or POSIX", () => {
    b.addBatchFiles(["C:\\vids\\a.mp4", "/home/u/b.mov"]);
    expect(b.batch.files.map((f) => f.name)).toEqual(["a.mp4", "b.mov"]);
    expect(b.batch.files.every((f) => f.status === "queued")).toBe(true);
  });

  it("ignores duplicates, within a call and across calls", () => {
    b.addBatchFiles(["/x/a.mp4"]);
    b.addBatchFiles(["/x/a.mp4", "/x/c.mp4"]);
    expect(b.batch.files.map((f) => f.path)).toEqual(["/x/a.mp4", "/x/c.mp4"]);
  });

  it("removes by index and counts finished files", () => {
    b.addBatchFiles(["/1.mp4", "/2.mp4", "/3.mp4"]);
    b.removeBatchFile(1);
    expect(b.batch.files.map((f) => f.path)).toEqual(["/1.mp4", "/3.mp4"]);
    expect(b.doneCount()).toBe(0);
  });

  it("does not let the queue change while a run is active", () => {
    b.addBatchFiles(["/1.mp4"]);
    b.setBatchRunning(true);
    b.removeBatchFile(0);
    b.clearBatch();
    expect(b.batch.files).toHaveLength(1);
    b.setBatchRunning(false);
  });

  it("flags only in-flight statuses as working", () => {
    for (const s of ["extracting", "transcribing", "exporting", "burning"] as const) {
      expect(b.isWorking(s)).toBe(true);
    }
    for (const s of ["queued", "done", "error", "cancelled"] as const) {
      expect(b.isWorking(s)).toBe(false);
    }
  });
});
