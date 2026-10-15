// CaptionSmith's Tauri commands, implemented for the browser build. Each mirrors
// its Rust counterpart in src-tauri/src (same arguments, results and events):
// transcription runs Whisper base in a Web Worker, burn-in runs ffmpeg.wasm with
// libass and the bundled Syne/Inter fonts, and subtitle import/export are ports
// of subimport.rs / subtitles.rs. Speaker detection, link import, extra model
// downloads and the update check need the desktop app.
import type { Segment, Word, ModelInfo } from "../src/transcription";
import { emitLocal } from "./shim/event";
import { download, DOWNLOADS, getFile, putFile, basename } from "./shim/vfs";
import { cancel, ffmpeg, mountInput, probe, run, take } from "./shim/engine";

const DESKTOP = "runs in the desktop app";

// ---- subtitles.rs -----------------------------------------------------------

type CaptionStyle = {
  font: string; fontSizePct: number; weight: number; primaryColor: string; highlightColor: string;
  perWord: boolean; emphasis: string; colorBySpeaker: boolean; outline: number; shadow: boolean;
  box: boolean; position: number; maxWordsPerLine: number; uppercase: boolean; safeMargin: number;
};

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
function hms(t: number): [number, number, number, number] {
  const ms = Math.round(Math.max(0, t) * 1000);
  return [Math.floor(ms / 3_600_000), Math.floor(ms / 60_000) % 60, Math.floor(ms / 1000) % 60, ms % 1000];
}
const srtTime = (t: number) => { const [h, m, s, ms] = hms(t); return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`; };
const vttTime = (t: number) => { const [h, m, s, ms] = hms(t); return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`; };
const assTime = (t: number) => { const [h, m, s, ms] = hms(t); return `${h}:${pad(m)}:${pad(s)}.${pad(Math.floor(ms / 10))}`; };
const cueText = (s: string) => s.replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean).join("\n");

export function toSrt(segs: Segment[]): string {
  let out = "", n = 1;
  for (const seg of segs) {
    const text = cueText(seg.text);
    if (!text) continue;
    out += `${n}\n${srtTime(seg.start)} --> ${srtTime(seg.end)}\n${text}\n\n`;
    n++;
  }
  return out;
}

export function toVtt(segs: Segment[]): string {
  let out = "WEBVTT\n\n";
  for (const seg of segs) {
    const text = cueText(seg.text);
    if (text) out += `${vttTime(seg.start)} --> ${vttTime(seg.end)}\n${text}\n\n`;
  }
  return out;
}

const assEscape = (s: string) => s.replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}");
const cased = (s: string, up: boolean) => (up ? s.toUpperCase() : s);
// MUST match SPEAKER_PALETTE in src/diarize.ts and subtitles.rs.
const SPEAKER_PALETTE = ["#45f2f2", "#a974ff", "#ffd24d", "#6ee27a", "#ff7a7a", "#7ab8ff", "#ff9de0", "#ffa94d"];
function assColor(hex: string): string {
  const h = hex.replace(/^#+/, "");
  const byte = (i: number) => { const v = parseInt(h.slice(i, i + 2), 16); return Number.isNaN(v) || h.slice(i, i + 2).length < 2 ? 255 : v; };
  const [r, g, b] = h.length >= 6 ? [byte(0), byte(2), byte(4)] : [255, 255, 255];
  const x = (v: number) => v.toString(16).toUpperCase().padStart(2, "0");
  return `&H00${x(b)}${x(g)}${x(r)}`;
}
function wrap(words: string[], max: number): string {
  const per = Math.max(1, max);
  return words.map((w, i) => (i > 0 ? (i % per === 0 ? "\\N" : " ") : "") + w).join("");
}
function emphasisTags(emphasis: string, pri: string, hi: string): [string, string] {
  if (emphasis === "grow") return [`{\\c${hi}&\\fscx118\\fscy118}`, `{\\c${pri}&\\fscx100\\fscy100}`];
  if (emphasis === "underline") return [`{\\c${hi}&\\u1}`, `{\\c${pri}&\\u0}`];
  return [`{\\c${hi}&}`, `{\\c${pri}&}`];
}
function wrapHighlight(words: string[], active: number, max: number, pri: string, hi: string, emphasis: string): string {
  const per = Math.max(1, max);
  const [open, close] = emphasisTags(emphasis, pri, hi);
  return words.map((w, i) => (i > 0 ? (i % per === 0 ? "\\N" : " ") : "") + (i === active ? `${open}${w}${close}` : w)).join("");
}
const dialogue = (s: number, e: number, text: string) => `Dialogue: 0,${assTime(s)},${assTime(e)},Default,,0,0,0,,${text}\n`;

export function toAss(segs: Segment[], st: CaptionStyle, w: number, h: number): string {
  const fontsize = Math.max(1, Math.round((st.fontSizePct / 100) * h));
  const primary = assColor(st.primaryColor);
  const bold = st.weight >= 700 ? -1 : 0;
  let border = 1, outlineCol = "&H00000000", backCol = "&H00000000", outline: number, shadow: number;
  if (st.box) {
    border = 3; outlineCol = backCol = "&H66000000";
    outline = Math.max(2, Math.round(fontsize * 0.15)); shadow = 0;
  } else {
    outline = Math.max(0, Math.round(st.outline * 0.02 * fontsize)); shadow = st.shadow ? 2 : 0;
  }
  const marginV = Math.max(0, Math.round(((100 - st.position) / 100) * h));
  const marginH = Math.max(0, Math.round((st.safeMargin / 100) * w));
  const max = st.maxWordsPerLine;
  let s = "[Script Info]\nScriptType: v4.00+\n";
  s += `PlayResX: ${w}\nPlayResY: ${h}\n`;
  s += "ScaledBorderAndShadow: yes\nWrapStyle: 0\n\n[V4+ Styles]\n";
  s += "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n";
  s += `Style: Default,${st.font},${fontsize},${primary},${primary},${outlineCol},${backCol},${bold},0,0,0,100,100,0,0,${border},${outline},${shadow},2,${marginH},${marginH},${marginV},1\n\n`;
  s += "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";
  for (const seg of segs) {
    if (!seg.text.trim()) continue;
    const segColor = st.colorBySpeaker && seg.speaker != null ? assColor(SPEAKER_PALETTE[seg.speaker % SPEAKER_PALETTE.length]) : null;
    const segPrimary = segColor ?? primary;
    if (st.perWord && seg.words?.length) {
      const words = seg.words;
      const esc = words.map((x) => assEscape(cased(x.text.trim(), st.uppercase)));
      const hi = assColor(st.highlightColor);
      words.forEach((x, i) => {
        const end = i + 1 < words.length ? words[i + 1].start : seg.end;
        if (end > x.start) s += dialogue(x.start, end, wrapHighlight(esc, i, max, segPrimary, hi, st.emphasis));
      });
      continue;
    }
    const body = wrap(seg.text.split(/\s+/).filter(Boolean).map((x) => assEscape(cased(x, st.uppercase))), max);
    s += dialogue(seg.start, seg.end, segColor ? `{\\c${segColor}&}${body}` : body);
  }
  return s;
}

function saveText(path: string, text: string, type: string) {
  const blob = new Blob([text], { type });
  putFile(path, blob);
  download(blob, basename(path));
}

async function exportSidecar(a: { segments: Segment[]; style: CaptionStyle; format: string; path: string }): Promise<void> {
  const content =
    a.format === "srt" ? toSrt(a.segments) : a.format === "vtt" ? toVtt(a.segments) : a.format === "ass" ? toAss(a.segments, a.style, 1920, 1080) : null;
  if (content == null) throw `Unknown subtitle format: ${a.format}`;
  saveText(a.path, content, a.format === "vtt" ? "text/vtt" : "text/plain");
}

// ---- subimport.rs -----------------------------------------------------------

function parseTimestamp(s: string): number | null {
  const token = s.trim().split(/\s+/)[0]?.replace(",", ".");
  if (!token) return null;
  const parts = token.split(":");
  const num = (x: string) => (/^\d+(\.\d+)?$/.test(x) ? parseFloat(x) : NaN);
  let h = 0, m: number, sec: number;
  if (parts.length === 3) { h = num(parts[0]); m = num(parts[1]); sec = num(parts[2]); }
  else if (parts.length === 2) { m = num(parts[0]); sec = num(parts[1]); }
  else return null;
  return [h, m, sec].some(Number.isNaN) ? null : h * 3600 + m * 60 + sec;
}

export function parseSubtitles(content: string): Segment[] {
  const text = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const segs: Segment[] = [];
  for (const block of text.split("\n\n")) {
    const lines = block.split("\n");
    const ai = lines.findIndex((l) => l.includes("-->"));
    if (ai < 0) continue;
    const [left, right] = [lines[ai].slice(0, lines[ai].indexOf("-->")), lines[ai].slice(lines[ai].indexOf("-->") + 3)];
    const start = parseTimestamp(left), end = parseTimestamp(right);
    if (start == null || end == null) continue;
    const body = lines.slice(ai + 1).map((l) => l.replace(/<[^>]*>?/g, "").trim()).filter(Boolean).join(" ").split(/\s+/).filter(Boolean).join(" ");
    if (body) segs.push({ start, end, text: body });
  }
  return segs.sort((a, b) => a.start - b.start);
}

async function importSubtitles({ path }: { path: string }): Promise<Segment[]> {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext !== "srt" && ext !== "vtt") throw "Please choose a .srt or .vtt subtitle file.";
  let content: string;
  try { content = await getFile(path).blob.text(); } catch (e) { throw `Could not read the file: ${e}`; }
  const segs = parseSubtitles(content);
  if (!segs.length) throw "No subtitle cues were found in this file.";
  return segs;
}

// ---- transcription (transcribe.rs / ffmpeg.rs extract) ----------------------

let worker: Worker | null = null;
let abortTranscribe: ((e: unknown) => void) | null = null;

async function audio16k(path: string): Promise<Float32Array> {
  const blob = getFile(path).blob;
  try {
    const ctx = new OfflineAudioContext(1, 16000, 16000);
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    if (buf.numberOfChannels === 1) return buf.getChannelData(0);
    const out = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) out[i] += d[i] / buf.numberOfChannels; }
    return out;
  } catch {
    // Containers the browser can't decode (e.g. some MKV/AVI): extract with ffmpeg.wasm.
    const f = await ffmpeg();
    const m = await mountInput(f, path);
    try {
      const secs = parseFloat((await probe(path).catch(() => null))?.format?.duration ?? "0") || 0;
      await run(["-i", m.file, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-y", "/audio.f32"], {
        outSecs: secs, onProgress: (r) => emitLocal("extract-progress", { percent: r * 100 }),
      });
      const raw = await take("/audio.f32", "application/octet-stream");
      return new Float32Array(await raw.arrayBuffer());
    } catch (e) {
      throw String(e).includes("does not contain any stream") || String(e).includes("matches no streams") ? "This video has no audio track to transcribe." : e;
    } finally { await m.unmount(); }
  }
}

type Chunk = { text: string; timestamp: [number, number | null] };

/** Group word chunks into caption segments, the way whisper.cpp splits on
 *  sentence ends and pauses. */
function segmentsFromWords(words: Word[]): Segment[] {
  const segs: Segment[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    segs.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.text).join(" "), words: cur });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && (w.start - prev.end > 1.0 || w.end - cur[0].start > 5)) flush();
    cur.push(w);
    if (/[.!?…]["')\]]?$/.test(w.text) || (/,$/.test(w.text) && w.end - cur[0].start > 2.5)) flush();
  }
  flush();
  return segs;
}

async function transcribe(a: { src: string; language: string | null; translate: boolean; wordTimestamps: boolean }): Promise<Segment[]> {
  emitLocal("extract-progress", { percent: null });
  const audio = await audio16k(a.src);
  if (!audio.length || audio.every((v) => v === 0)) throw "This video has no audio to transcribe.";
  emitLocal("transcribe-note", { message: "Running Whisper base in your browser. The first run downloads the model (77 MB)." });
  worker ??= new Worker(new URL("./whisper.worker.ts", import.meta.url), { type: "module" });
  const w = worker;
  const result = await new Promise<{ chunks: Chunk[]; secs: number }>((resolve, reject) => {
    abortTranscribe = reject;
    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === "load") emitLocal("transcribe-note", { message: `Loading the Whisper model… ${m.percent != null ? Math.round(m.percent) + "%" : ""}` });
      else if (m.type === "progress") emitLocal("transcribe-progress", { percent: m.percent });
      else if (m.type === "done") resolve(m);
      else if (m.type === "error") reject(m.message);
    };
    w.onerror = (e) => reject(e.message || "Transcription failed in the browser.");
    w.postMessage({ audio, language: a.language, translate: a.translate, words: a.wordTimestamps }, [audio.buffer]);
  }).finally(() => { abortTranscribe = null; });
  emitLocal("transcribe-note", { message: "" });
  emitLocal("transcribe-progress", { percent: 100 });
  const end = (c: Chunk) => c.timestamp[1] ?? result.secs;
  if (a.wordTimestamps) {
    const words = result.chunks.map((c) => ({ start: c.timestamp[0], end: end(c), text: c.text.trim() })).filter((x) => x.text);
    return segmentsFromWords(words);
  }
  return result.chunks.map((c) => ({ start: c.timestamp[0], end: end(c), text: c.text.trim() })).filter((s) => s.text);
}

function cancelTranscribe() {
  if (!abortTranscribe) return;
  worker?.terminate();
  worker = null; // the model reloads from the HTTP cache next time
  abortTranscribe("cancelled");
}

// ---- burn-in (ffmpeg.rs) ----------------------------------------------------

async function burnIn(a: { src: string; segments: Segment[]; style: CaptionStyle; out: string }): Promise<void> {
  const info = await probe(a.src);
  const v = info.streams?.find((s) => s.codec_type === "video");
  if (!v?.width || !v?.height) throw "Could not read the video's dimensions.";
  const f = await ffmpeg();
  await f.writeFile("/captions.ass", new TextEncoder().encode(toAss(a.segments, a.style, v.width, v.height)));
  const m = await mountInput(f, a.src);
  emitLocal("burn-progress", { percent: 0 });
  try {
    await run([
      "-i", m.file, "-vf", "ass=/captions.ass:fontsdir=/fonts",
      "-c:v", "libx264", "-crf", "18", "-preset", "veryfast",
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-y", "/burn.mp4",
    ], { outSecs: parseFloat(info.format?.duration ?? "0") || 0, onProgress: (r) => emitLocal("burn-progress", { percent: r * 100 }) });
    const blob = await take("/burn.mp4", "video/mp4");
    putFile(a.out, blob);
    download(blob, basename(a.out));
    emitLocal("burn-progress", { percent: 100 });
  } catch (e) {
    throw String(e) === "Export cancelled" ? "cancelled" : e;
  } finally {
    await m.unmount();
  }
}

// ---- registry ---------------------------------------------------------------

const listModels = (): ModelInfo[] => [{ name: "", label: "Base · multilingual (in browser)", multilingual: true, is_default: true }];

export const commands: Record<string, (args: never) => unknown> = {
  transcribe,
  cancel_transcribe: cancelTranscribe,
  list_models: listModels,
  import_subtitles: importSubtitles,
  export_sidecar: exportSidecar,
  burn_in: burnIn,
  cancel_burn: () => cancel(),
  ensure_export_dir: () => DOWNLOADS,
  models_folder: () => "Built into this page",
  download_model: () => { throw `Larger Whisper models ${DESKTOP}. The browser demo uses Whisper base.`; },
  import_model: () => { throw `Custom models ${DESKTOP}.`; },
  delete_model: () => { throw `Model management ${DESKTOP}.`; },
  cancel_model_download: () => undefined,
  diarize: () => { throw `Speaker detection ${DESKTOP}.`; },
  diarization_models_present: () => false,
  download_diarization_models: () => { throw `Speaker detection ${DESKTOP}.`; },
  cancel_diarize: () => undefined,
  cancel_diarization_download: () => undefined,
  download_url: () => { throw `Importing from a link ${DESKTOP}. Open a file from your computer instead.`; },
  cancel_download: () => undefined,
  check_for_update: () => ({ current: __APP_VERSION__, latest: __APP_VERSION__, is_newer: false, notes: "", url: "" }),
  open_release_page: ({ url }: { url: string }) => { window.open(url, "_blank", "noopener"); },
};
