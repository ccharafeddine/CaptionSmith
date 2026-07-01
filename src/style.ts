// Shared caption-style state. Read by the caption overlay (live HTML preview)
// and the style panel. The burn-in export (Step 9) maps these to libass/ASS,
// which is the authoritative look; the HTML preview is a close approximation.

import { createStore } from "solid-js/store";

export type Preset = "bottomBar" | "boldSocial" | "wordHighlight";

export type CaptionStyle = {
  preset: Preset;
  font: string; // CSS font-family (also the ASS font name for burn-in)
  fontSizePct: number; // caption height as % of video height
  weight: number; // font-weight
  primaryColor: string; // #rrggbb
  highlightColor: string; // active-word color (word highlight)
  outline: number; // 0..10 (stroke em = outline * 0.02)
  shadow: boolean;
  box: boolean; // semi-transparent background behind lines
  position: number; // 0..100 vertical, % from top (caption block center)
  maxWordsPerLine: number;
  uppercase: boolean;
  safeMargin: number; // % horizontal margin
};

export const FONTS = [
  { label: "Syne", value: '"Syne", sans-serif' },
  { label: "Arial", value: "Arial, Helvetica, sans-serif" },
  { label: "Impact", value: "Impact, Haettenschweiler, sans-serif" },
  { label: "Georgia", value: "Georgia, 'Times New Roman', serif" },
];

const SYNE = FONTS[0].value;

// Per-preset field overrides applied on top of the current style.
const PRESETS: Record<Preset, Omit<CaptionStyle, "preset">> = {
  bottomBar: {
    font: SYNE,
    fontSizePct: 5.5,
    weight: 600,
    primaryColor: "#ffffff",
    highlightColor: "#45f2f2",
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
    outline: 5,
    shadow: true,
    box: false,
    position: 74,
    maxWordsPerLine: 4,
    uppercase: true,
    safeMargin: 8,
  },
  wordHighlight: {
    font: SYNE,
    fontSizePct: 8,
    weight: 800,
    primaryColor: "#ffffff",
    highlightColor: "#45f2f2",
    outline: 4,
    shadow: true,
    box: false,
    position: 74,
    maxWordsPerLine: 4,
    uppercase: true,
    safeMargin: 8,
  },
};

export const [style, setStyle] = createStore<CaptionStyle>({
  preset: "bottomBar",
  ...PRESETS.bottomBar,
});

/** Reset all style fields to a preset's look. */
export function applyPreset(preset: Preset) {
  setStyle({ preset, ...PRESETS[preset] });
}
