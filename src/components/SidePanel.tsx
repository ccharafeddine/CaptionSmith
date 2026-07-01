import { type Accessor, createSignal } from "solid-js";

import TranscriptPanel from "./TranscriptPanel";
import StylePanel from "./StylePanel";

type Tab = "transcript" | "style";

type SidePanelProps = {
  currentTime: Accessor<number>;
  onSeek: (seconds: number) => void;
};

export default function SidePanel(props: SidePanelProps) {
  const [tab, setTab] = createSignal<Tab>("transcript");

  return (
    <aside class="side-panel">
      <div class="tabs">
        <button
          type="button"
          class="tab"
          classList={{ active: tab() === "transcript" }}
          onClick={() => setTab("transcript")}
        >
          Transcript
        </button>
        <button
          type="button"
          class="tab"
          classList={{ active: tab() === "style" }}
          onClick={() => setTab("style")}
        >
          Style
        </button>
      </div>

      {/* Both stay mounted so switching tabs preserves their state. */}
      <div class="side-body" classList={{ hidden: tab() !== "transcript" }}>
        <TranscriptPanel currentTime={props.currentTime} onSeek={props.onSeek} />
      </div>
      <div class="side-body" classList={{ hidden: tab() !== "style" }}>
        <StylePanel />
      </div>
    </aside>
  );
}
