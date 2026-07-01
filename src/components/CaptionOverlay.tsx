import { type Accessor, createMemo, For, type JSX, Show } from "solid-js";

import { transcript } from "../transcription";
import { style } from "../style";

type CaptionOverlayProps = {
  currentTime: Accessor<number>;
};

type Token = { text: string; start: number; end: number };

/** Split tokens into lines of at most `max` tokens. */
function chunk(tokens: Token[], max: number): Token[][] {
  const per = Math.max(1, Math.floor(max));
  const lines: Token[][] = [];
  for (let i = 0; i < tokens.length; i += per) {
    lines.push(tokens.slice(i, i + per));
  }
  return lines;
}

export default function CaptionOverlay(props: CaptionOverlayProps) {
  const activeSegment = createMemo(() => {
    const t = props.currentTime();
    return transcript.segments.find((s) => t >= s.start && t < s.end) ?? null;
  });

  const useWords = () =>
    style.preset === "wordHighlight" &&
    !!activeSegment()?.words &&
    activeSegment()!.words!.length > 0;

  const lines = createMemo<Token[][]>(() => {
    const seg = activeSegment();
    if (!seg) return [];
    const tokens: Token[] = useWords()
      ? seg.words!.map((w) => ({ text: w.text, start: w.start, end: w.end }))
      : seg.text
          .split(/\s+/)
          .filter(Boolean)
          .map((text) => ({ text, start: seg.start, end: seg.end }));
    return chunk(tokens, style.maxWordsPerLine);
  });

  const display = (text: string) => (style.uppercase ? text.toUpperCase() : text);

  const isActiveWord = (tok: Token) => {
    if (!useWords()) return false;
    const t = props.currentTime();
    return t >= tok.start && t < tok.end;
  };

  const blockStyle = (): JSX.CSSProperties => {
    const s: JSX.CSSProperties = {
      top: `${style.position}%`,
      left: `${style.safeMargin}%`,
      right: `${style.safeMargin}%`,
      "font-family": style.font,
      "font-size": `${style.fontSizePct}cqh`,
      "font-weight": String(style.weight),
      color: style.primaryColor,
      "paint-order": "stroke fill",
    };
    if (style.outline > 0) {
      s["-webkit-text-stroke"] = `${style.outline * 0.02}em #000000`;
    }
    if (style.shadow) {
      s["text-shadow"] = "0 0.04em 0.09em rgba(0,0,0,0.75)";
    }
    return s;
  };

  return (
    <div class="caption-overlay">
      <Show when={activeSegment()}>
        <div class="caption-block" style={blockStyle()}>
          <For each={lines()}>
            {(line) => (
              <div class="caption-line" classList={{ box: style.box }}>
                <For each={line}>
                  {(tok) => (
                    <span
                      class="caption-word"
                      classList={{ active: isActiveWord(tok) }}
                      style={
                        isActiveWord(tok)
                          ? { color: style.highlightColor }
                          : undefined
                      }
                    >
                      {display(tok.text)}{" "}
                    </span>
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
