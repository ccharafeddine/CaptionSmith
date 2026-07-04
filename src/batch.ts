// Batch captioning: run several files through transcribe -> export/burn-in in
// one pass, reusing the exact per-file backend commands the single-file flow
// uses. No editing step (you can't hand-edit N transcripts), so each file is
// transcribed and captioned with the current model/language/GPU settings and
// caption style. Sequential, cancellable, and resilient — one file failing
// doesn't stop the rest.

import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { style } from "./style";
import {
  gpuEnabled,
  language,
  modelName,
  multilingualSelected,
  translate,
  type Segment,
} from "./transcription";

export type BatchFormat = "srt" | "vtt" | "ass" | "mp4";

export type FileStatus =
  | "queued"
  | "extracting"
  | "transcribing"
  | "exporting"
  | "burning"
  | "done"
  | "error"
  | "cancelled";

export type BatchFile = {
  path: string;
  name: string;
  status: FileStatus;
  percent: number | null;
  output?: string;
  error?: string;
};

export const [batch, setBatch] = createStore<{ files: BatchFile[] }>({
  files: [],
});
export const [batchFormat, setBatchFormat] = createSignal<BatchFormat>("srt");
export const [batchDir, setBatchDir] = createSignal("");
export const [batchRunning, setBatchRunning] = createSignal(false);

let cancelRequested = false;

const stem = (name: string) => {
  const d = name.lastIndexOf(".");
  return d > 0 ? name.slice(0, d) : name;
};
const base = (path: string) => {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
};

/** True while a file is mid-flight (shows a progress bar). */
export function isWorking(s: FileStatus): boolean {
  return (
    s === "extracting" ||
    s === "transcribing" ||
    s === "exporting" ||
    s === "burning"
  );
}

export function doneCount(): number {
  return batch.files.filter((f) => f.status === "done").length;
}

export function addBatchFiles(paths: string[]) {
  const existing = new Set(batch.files.map((f) => f.path));
  const fresh = paths
    .filter((p) => !existing.has(p))
    .map<BatchFile>((p) => ({
      path: p,
      name: base(p),
      status: "queued",
      percent: null,
    }));
  if (fresh.length) setBatch("files", (fs) => [...fs, ...fresh]);
}

export function removeBatchFile(i: number) {
  if (batchRunning()) return;
  setBatch("files", (fs) => fs.filter((_, idx) => idx !== i));
}

export function clearBatch() {
  if (!batchRunning()) setBatch("files", []);
}

export async function runBatch() {
  if (batchRunning() || batch.files.length === 0 || !batchDir()) return;
  cancelRequested = false;
  setBatchRunning(true);

  const fmt = batchFormat();
  const dir = batchDir();
  const multi = multilingualSelected();

  // One set of listeners for the whole run; `current` routes progress to the
  // file being processed (batch is strictly sequential).
  let current = -1;
  const unlisten: UnlistenFn[] = [];
  unlisten.push(
    await listen<{ percent: number | null }>("extract-progress", (e) => {
      if (current >= 0)
        setBatch("files", current, {
          status: "extracting",
          percent: e.payload.percent,
        });
    }),
  );
  unlisten.push(
    await listen<{ percent: number }>("transcribe-progress", (e) => {
      if (current >= 0)
        setBatch("files", current, {
          status: "transcribing",
          percent: e.payload.percent,
        });
    }),
  );
  unlisten.push(
    await listen<{ percent: number | null }>("burn-progress", (e) => {
      if (current >= 0)
        setBatch("files", current, {
          status: "burning",
          percent: e.payload.percent,
        });
    }),
  );

  try {
    for (let i = 0; i < batch.files.length; i++) {
      if (cancelRequested) break;
      if (batch.files[i].status === "done") continue; // don't redo finished files

      current = i;
      const file = batch.files[i];
      setBatch("files", i, {
        status: "extracting",
        percent: null,
        error: undefined,
        output: undefined,
      });

      try {
        const segments = await invoke<Segment[]>("transcribe", {
          src: file.path,
          language: multi ? language() : null,
          translate: multi && translate(),
          wordTimestamps: style.perWord,
          model: modelName() || null,
          gpu: gpuEnabled(),
        });
        if (cancelRequested) {
          setBatch("files", i, { status: "cancelled" });
          break;
        }

        const outName = stem(file.name);
        if (fmt === "mp4") {
          const out = `${dir}/${outName}_captioned.mp4`;
          setBatch("files", i, { status: "burning", percent: null });
          await invoke("burn_in", {
            src: file.path,
            segments,
            style: { ...style },
            out,
          });
          setBatch("files", i, { status: "done", percent: 100, output: out });
        } else {
          const out = `${dir}/${outName}.${fmt}`;
          setBatch("files", i, { status: "exporting", percent: null });
          await invoke("export_sidecar", {
            segments,
            style: { ...style },
            format: fmt,
            path: out,
          });
          setBatch("files", i, { status: "done", percent: 100, output: out });
        }
      } catch (e) {
        const msg = String(e);
        if (msg === "cancelled") {
          setBatch("files", i, { status: "cancelled" });
          if (cancelRequested) break;
        } else {
          // Record the error and keep going — one bad file shouldn't sink the batch.
          setBatch("files", i, { status: "error", error: msg });
        }
      }
    }
  } finally {
    current = -1;
    unlisten.forEach((u) => u());
    setBatchRunning(false);
  }
}

export async function cancelBatch() {
  cancelRequested = true;
  // Kill whichever per-file step is in flight; the other call is a harmless no-op.
  await invoke("cancel_transcribe").catch(() => {});
  await invoke("cancel_burn").catch(() => {});
}
