import { For, Show } from "solid-js";

import {
  applyPreset,
  type Emphasis,
  FONTS,
  type Preset,
  setStyle,
  style,
} from "../style";
import {
  hasWords,
  isBusy,
  runTranscribe,
  status,
  transcript,
} from "../transcription";

const PRESET_LABELS: { key: Preset; label: string }[] = [
  { key: "bottomBar", label: "Bottom bar" },
  { key: "boldSocial", label: "Bold social" },
  { key: "cleanTop", label: "Clean top" },
  { key: "neon", label: "Neon" },
  { key: "wordHighlight", label: "Word highlight" },
  { key: "karaokePop", label: "Karaoke pop" },
];

const EMPHASIS_LABELS: { key: Emphasis; label: string }[] = [
  { key: "color", label: "Color" },
  { key: "grow", label: "Grow" },
  { key: "underline", label: "Underline" },
];

export default function StylePanel() {
  // Per-word styles need per-word timings; offer to fetch them if missing.
  const needsWords = () =>
    style.perWord &&
    status() === "done" &&
    transcript.segments.length > 0 &&
    !hasWords();

  return (
    <div class="panel-content style-panel">
      <div class="style-scroll">
        <section class="style-section">
          <p class="style-heading">Preset</p>
          <div class="preset-grid">
            <For each={PRESET_LABELS}>
              {(p) => (
                <button
                  type="button"
                  class="preset-btn"
                  classList={{ active: style.preset === p.key }}
                  onClick={() => applyPreset(p.key)}
                >
                  {p.label}
                </button>
              )}
            </For>
          </div>

          <Show when={needsWords()}>
            <div class="word-cta">
              <p class="control-note">
                Word highlight needs word-level timing, which the current
                transcript doesn't have.
              </p>
              <button
                type="button"
                class="ghost-btn"
                disabled={isBusy()}
                onClick={() => runTranscribe(true)}
              >
                Re-transcribe with word timing
              </button>
            </div>
          </Show>
        </section>

        <section class="style-section">
          <p class="style-heading">Text</p>

          <label class="control-row">
            <span class="control-label">Font</span>
            <select
              class="select"
              value={style.font}
              onChange={(e) => setStyle("font", e.currentTarget.value)}
            >
              <For each={FONTS}>
                {(f) => <option value={f.value}>{f.label}</option>}
              </For>
            </select>
          </label>

          <SliderRow
            label="Size"
            min={3}
            max={14}
            step={0.5}
            value={style.fontSizePct}
            suffix="%"
            onInput={(v) => setStyle("fontSizePct", v)}
          />

          <label class="control-row">
            <span class="control-label">Color</span>
            <input
              class="color"
              type="color"
              value={style.primaryColor}
              onInput={(e) => setStyle("primaryColor", e.currentTarget.value)}
            />
          </label>

          <Show when={style.perWord}>
            <label class="control-row">
              <span class="control-label">Highlight</span>
              <input
                class="color"
                type="color"
                value={style.highlightColor}
                onInput={(e) => setStyle("highlightColor", e.currentTarget.value)}
              />
            </label>

            <label class="control-row">
              <span class="control-label">Active word</span>
              <select
                class="select"
                value={style.emphasis}
                onChange={(e) =>
                  setStyle("emphasis", e.currentTarget.value as Emphasis)
                }
              >
                <For each={EMPHASIS_LABELS}>
                  {(em) => <option value={em.key}>{em.label}</option>}
                </For>
              </select>
            </label>
          </Show>

          <label class="control-check">
            <input
              type="checkbox"
              checked={style.uppercase}
              onChange={(e) => setStyle("uppercase", e.currentTarget.checked)}
            />
            <span>UPPERCASE</span>
          </label>
        </section>

        <section class="style-section">
          <p class="style-heading">Emphasis</p>

          <SliderRow
            label="Outline"
            min={0}
            max={10}
            step={1}
            value={style.outline}
            onInput={(v) => setStyle("outline", v)}
          />

          <label class="control-check">
            <input
              type="checkbox"
              checked={style.shadow}
              onChange={(e) => setStyle("shadow", e.currentTarget.checked)}
            />
            <span>Drop shadow</span>
          </label>

          <label class="control-check">
            <input
              type="checkbox"
              checked={style.box}
              onChange={(e) => setStyle("box", e.currentTarget.checked)}
            />
            <span>Background box</span>
          </label>
        </section>

        <section class="style-section">
          <p class="style-heading">Layout</p>

          <SliderRow
            label="Position"
            min={50}
            max={95}
            step={1}
            value={style.position}
            suffix="%"
            onInput={(v) => setStyle("position", v)}
          />
          <SliderRow
            label="Words/line"
            min={1}
            max={12}
            step={1}
            value={style.maxWordsPerLine}
            onInput={(v) => setStyle("maxWordsPerLine", v)}
          />
          <SliderRow
            label="Margin"
            min={0}
            max={15}
            step={1}
            value={style.safeMargin}
            suffix="%"
            onInput={(v) => setStyle("safeMargin", v)}
          />
        </section>

        <p class="style-footnote">
          Preview is an approximation. The burn-in export uses libass, so the
          exported look is authoritative and may differ slightly.
        </p>
      </div>
    </div>
  );
}

function SliderRow(props: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  suffix?: string;
  onInput: (v: number) => void;
}) {
  return (
    <label class="control-row slider-row">
      <span class="control-label">{props.label}</span>
      <input
        class="slider"
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onInput={(e) => props.onInput(Number(e.currentTarget.value))}
      />
      <span class="slider-val">
        {props.value}
        {props.suffix ?? ""}
      </span>
    </label>
  );
}
