// Shared caption-style state. Read by the caption overlay (live HTML preview)
// and the style panel. The burn-in export (Step 9) maps these to libass/ASS,
// which is the authoritative look; the HTML preview is a close approximation.

import { createStore } from "solid-js/store";

export type Preset =
  | "bottomBar"
  | "boldSocial"
  | "cleanTop"
  | "neon"
  | "wordHighlight"
  | "karaokePop";

// How the active word is emphasized in a per-word (karaoke) style. All three are
// expressible in both the HTML preview and the ASS burn-in.
export type Emphasis = "color" | "grow" | "underline";

// Preset display order + labels, shared by the style panel and the batch modal.
export const PRESET_LABELS: { key: Preset; label: string }[] = [
  { key: "bottomBar", label: "Bottom bar" },
  { key: "boldSocial", label: "Bold social" },
  { key: "cleanTop", label: "Clean top" },
  { key: "neon", label: "Neon" },
  { key: "wordHighlight", label: "Word highlight" },
  { key: "karaokePop", label: "Karaoke pop" },
];

export type CaptionStyle = {
  preset: Preset;
  font: string; // CSS font-family (also the ASS font name for burn-in)
  fontSizePct: number; // caption height as % of video height
  weight: number; // font-weight
  primaryColor: string; // #rrggbb
  highlightColor: string; // active-word color (per-word styles)
  // Per-word (karaoke) timing: the active word is emphasized as it's spoken.
  // Decoupled from `preset` so any preset can opt in and new ones can too.
  perWord: boolean;
  emphasis: Emphasis; // how the active word pops (per-word styles only)
  // Color each caption by its speaker (item 6b). Orthogonal to the preset, so it
  // survives preset changes; only meaningful once speakers are detected.
  colorBySpeaker: boolean;
  outline: number; // 0..10 (stroke em = outline * 0.02)
  shadow: boolean;
  box: boolean; // semi-transparent background behind lines
  position: number; // 0..100 vertical, % from top (caption block center)
  maxWordsPerLine: number;
  uppercase: boolean;
  safeMargin: number; // % horizontal margin
};

// Plain family names: used verbatim as the ASS Fontname for burn-in, and
// wrapped with a fallback for the CSS preview.
export const FONTS = [
  { label: "Syne", value: "Syne" },
  { label: "Arial", value: "Arial" },
  { label: "Impact", value: "Impact" },
  { label: "Georgia", value: "Georgia" },
];

const SYNE = FONTS[0].value;

// Per-preset field overrides applied on top of the current style. `preset` and
// `colorBySpeaker` are excluded: the former is the key, the latter is a global
// toggle that must survive preset changes (applyPreset merges, so omitting it
// here preserves the current value).
const PRESETS: Record<Preset, Omit<CaptionStyle, "preset" | "colorBySpeaker">> = {
  bottomBar: {
    font: SYNE,
    fontSizePct: 5.5,
    weight: 600,
    primaryColor: "#ffffff",
    highlightColor: "#45f2f2",
    perWord: false,
    emphasis: "color",
    outline: 0,
    shadow: false,
    box: true,
    position: 88,
    maxWordsPerLine: 8,
    uppercase: false,
    safeMargin: 6,
  },
  boldSocial: {
    font: SYNE,
    fontSizePct: 8,
    weight: 800,
    primaryColor: "#ffffff",
    highlightColor: "#45f2f2",
    perWord: false,
    emphasis: "color",
    outline: 5,
    shadow: true,
    box: false,
    position: 74,
    maxWordsPerLine: 4,
    uppercase: true,
    safeMargin: 8,
  },
  // Small, unobtrusive line pinned near the top — for when the lower third is
  // busy (lower-third graphics, a speaker's face).
  cleanTop: {
    font: SYNE,
    fontSizePct: 4.5,
    weight: 500,
    primaryColor: "#ffffff",
    highlightColor: "#45f2f2",
    perWord: false,
    emphasis: "color",
    outline: 0,
    shadow: false,
    box: true,
    position: 16,
    maxWordsPerLine: 8,
    uppercase: false,
    safeMargin: 6,
  },
  // Bright on-brand cyan with a heavy outline — a loud, attention-grabbing look.
  neon: {
    font: SYNE,
    fontSizePct: 8,
    weight: 800,
    primaryColor: "#45f2f2",
    highlightColor: "#a974ff",
    perWord: false,
    emphasis: "color",
    outline: 6,
    shadow: true,
    box: false,
    position: 78,
    maxWordsPerLine: 4,
    uppercase: true,
    safeMargin: 8,
  },
  // Karaoke: the active word recolors (cyan) as it's spoken.
  wordHighlight: {
    font: SYNE,
    fontSizePct: 8,
    weight: 800,
    primaryColor: "#ffffff",
    highlightColor: "#45f2f2",
    perWord: true,
    emphasis: "color",
    outline: 4,
    shadow: true,
    box: false,
    position: 74,
    maxWordsPerLine: 4,
    uppercase: true,
    safeMargin: 8,
  },
  // Karaoke with a bigger punch: the active word grows and recolors (violet) —
  // the modern TikTok/Reels caption "pop".
  karaokePop: {
    font: SYNE,
    fontSizePct: 8.5,
    weight: 800,
    primaryColor: "#ffffff",
    highlightColor: "#a974ff",
    perWord: true,
    emphasis: "grow",
    outline: 4,
    shadow: true,
    box: false,
    position: 74,
    maxWordsPerLine: 3,
    uppercase: true,
    safeMargin: 8,
  },
};

export const [style, setStyle] = createStore<CaptionStyle>({
  preset: "bottomBar",
  colorBySpeaker: false,
  ...PRESETS.bottomBar,
});

/** Reset all style fields to a preset's look. */
export function applyPreset(preset: Preset) {
  setStyle({ preset, ...PRESETS[preset] });
}
