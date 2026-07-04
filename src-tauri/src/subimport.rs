// Bring-your-own transcript: parse an existing .srt or .vtt subtitle file into
// the same editable Segment list transcription produces, so the user can style
// and burn in captions without running whisper at all.
//
// One block parser covers both formats — their cue structure is identical
// (timestamp line "start --> end" followed by text lines); the differences
// (VTT's WEBVTT header, NOTE/STYLE/REGION blocks, `.`-vs-`,` millisecond
// separator, inline <tags> and trailing cue settings) are all absorbed here.
//
// Imported cues carry no word-level timings (subtitle files don't have them),
// so `words` is always None; the word-highlight style falls back to plain
// wrapping for these, exactly as it does for a word-less transcription.

use std::cmp::Ordering;
use std::path::Path;

use crate::transcribe::Segment;

/// Read + parse a .srt or .vtt file at `path`. Errors clearly on the wrong
/// extension, an unreadable file, or a file with no recognizable cues.
#[tauri::command]
pub fn import_subtitles(path: String) -> Result<Vec<Segment>, String> {
    let ext = Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if ext != "srt" && ext != "vtt" {
        return Err("Please choose a .srt or .vtt subtitle file.".into());
    }

    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("Could not read the file: {e}"))?;

    let segments = parse_subtitles(&content);
    if segments.is_empty() {
        return Err("No subtitle cues were found in this file.".into());
    }
    Ok(segments)
}

/// Parse SRT or VTT text into ordered segments. Blocks are separated by blank
/// lines; any block without a "-->" line (the WEBVTT header, NOTE/STYLE/REGION,
/// stray index lines on their own) is skipped.
fn parse_subtitles(content: &str) -> Vec<Segment> {
    // Strip a UTF-8 BOM and normalize line endings so block-splitting is simple.
    let text = content
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");

    let mut segments: Vec<Segment> = Vec::new();

    for block in text.split("\n\n") {
        let lines: Vec<&str> = block.lines().collect();
        let Some(arrow_idx) = lines.iter().position(|l| l.contains("-->")) else {
            continue; // header / note / blank / id-only block
        };

        let arrow_line = lines[arrow_idx];
        let Some((left, right)) = arrow_line.split_once("-->") else {
            continue;
        };
        let (Some(start), Some(end)) = (parse_timestamp(left), parse_timestamp(right)) else {
            continue; // malformed timing line
        };

        // Everything after the timing line is caption text (a line before it is a
        // cue identifier / SRT index — ignored). Strip inline tags, drop blanks.
        let text = lines[arrow_idx + 1..]
            .iter()
            .map(|l| strip_tags(l))
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        let text = collapse_whitespace(&text);
        if text.is_empty() {
            continue;
        }

        segments.push(Segment {
            start,
            end,
            text,
            words: None,
            speaker: None,
        });
    }

    // Subtitle files are usually ordered, but the transcript editor assumes a
    // start-sorted list (its nudge/split ops maintain that invariant), so sort.
    segments.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(Ordering::Equal));
    segments
}

/// Parse one timestamp token to seconds. Accepts `HH:MM:SS.mmm`, `MM:SS.mmm`,
/// SRT's comma separator (`,mmm`), and ignores trailing VTT cue settings
/// (e.g. "00:00:01.000 line:90%") by taking only the first whitespace token.
fn parse_timestamp(s: &str) -> Option<f64> {
    let token = s.split_whitespace().next()?.replace(',', ".");
    let parts: Vec<&str> = token.split(':').collect();
    let (h, m, sec) = match parts.as_slice() {
        [h, m, sec] => (h.parse::<f64>().ok()?, m.parse::<f64>().ok()?, *sec),
        [m, sec] => (0.0, m.parse::<f64>().ok()?, *sec),
        _ => return None,
    };
    let sec = sec.parse::<f64>().ok()?;
    Some(h * 3600.0 + m * 60.0 + sec)
}

/// Remove angle-bracket tags (`<v Speaker>`, `<c>`, `<00:00:01.000>`, `<b>`)
/// from VTT cue text, keeping the visible words.
fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

/// Collapse runs of whitespace (including the newlines we joined on) to single
/// spaces, so each imported cue is one clean line the styler can re-wrap.
fn collapse_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_srt() {
        let srt = "1\n00:00:00,000 --> 00:00:01,500\nHello world\n\n\
                   2\n00:00:01,500 --> 00:00:03,000\nSecond line\n";
        let segs = parse_subtitles(srt);
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].start, 0.0);
        assert_eq!(segs[0].end, 1.5);
        assert_eq!(segs[0].text, "Hello world");
        assert!(segs[0].words.is_none());
        assert_eq!(segs[1].start, 1.5);
        assert_eq!(segs[1].text, "Second line");
    }

    #[test]
    fn parses_basic_vtt_with_header_and_note() {
        let vtt = "WEBVTT - My captions\n\n\
                   NOTE this is a note\nspanning two lines\n\n\
                   00:00:00.000 --> 00:00:02.000\nHi there\n\n\
                   cue-id\n00:00:02.000 --> 00:00:04.000\nNamed cue\n";
        let segs = parse_subtitles(vtt);
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].text, "Hi there");
        assert_eq!(segs[0].end, 2.0);
        // The "cue-id" identifier line before the timing must be dropped.
        assert_eq!(segs[1].text, "Named cue");
    }

    #[test]
    fn joins_multiline_cue_and_strips_vtt_tags() {
        let vtt = "WEBVTT\n\n\
                   00:00:00.000 --> 00:00:02.000\n<v Alice>Line one</v>\nline two\n";
        let segs = parse_subtitles(vtt);
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].text, "Line one line two");
    }

    #[test]
    fn ignores_vtt_cue_settings_after_end_time() {
        let vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.500 line:90% position:50%\nText\n";
        let segs = parse_subtitles(vtt);
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].start, 1.0);
        assert_eq!(segs[0].end, 2.5);
    }

    #[test]
    fn handles_mm_ss_timestamps_and_bom() {
        let vtt = "\u{feff}WEBVTT\n\n01:02.500 --> 01:04.000\nShort form\n";
        let segs = parse_subtitles(vtt);
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].start, 62.5);
        assert_eq!(segs[0].end, 64.0);
    }

    #[test]
    fn sorts_out_of_order_cues() {
        let srt = "1\n00:00:05,000 --> 00:00:06,000\nLater\n\n\
                   2\n00:00:01,000 --> 00:00:02,000\nEarlier\n";
        let segs = parse_subtitles(srt);
        assert_eq!(segs[0].text, "Earlier");
        assert_eq!(segs[1].text, "Later");
    }

    #[test]
    fn skips_blocks_without_timing_or_text() {
        let srt = "1\n00:00:00,000 --> 00:00:01,000\n\n\n\
                   2\n00:00:01,000 --> 00:00:02,000\nReal\n";
        // First cue has no text -> dropped; only the second survives.
        let segs = parse_subtitles(srt);
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].text, "Real");
    }

    #[test]
    fn empty_input_yields_no_segments() {
        assert!(parse_subtitles("").is_empty());
        assert!(parse_subtitles("WEBVTT\n\nNOTE nothing here\n").is_empty());
    }

    #[test]
    fn parse_timestamp_forms() {
        assert_eq!(parse_timestamp("00:00:01,500"), Some(1.5));
        assert_eq!(parse_timestamp(" 1:02:03.250 "), Some(3723.25));
        assert_eq!(parse_timestamp("00:02.000 line:90%"), Some(2.0));
        assert_eq!(parse_timestamp("nonsense"), None);
    }
}

// Integration coverage: exercises the real `import_subtitles` command (file I/O
// + error paths) and proves imported segments flow through the real exporters
// and the burn-in ASS builder. This is the part of item 2 that would otherwise
// only be checked by clicking through the live window.
#[cfg(test)]
mod integration {
    use super::*;
    use crate::subtitles::{to_ass, to_srt, to_vtt, CaptionStyle};
    use std::fs;
    use std::path::PathBuf;

    /// A per-test temp file (distinct `name` per test avoids collisions when the
    /// suite runs in parallel within one process).
    fn temp_file(name: &str, body: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("captionsmith-it-{}-{name}", std::process::id()));
        fs::write(&path, body).unwrap();
        path
    }

    fn path_str(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    fn style() -> CaptionStyle {
        CaptionStyle {
            font: "Syne".into(),
            font_size_pct: 5.0,
            weight: 600,
            primary_color: "#ffffff".into(),
            highlight_color: "#45f2f2".into(),
            per_word: false,
            emphasis: "color".into(),
            color_by_speaker: false,
            outline: 0.0,
            shadow: false,
            boxed: true,
            position: 88.0,
            max_words_per_line: 8,
            uppercase: false,
            safe_margin: 6.0,
        }
    }

    #[test]
    fn command_reads_a_real_srt_file() {
        let p = temp_file(
            "basic.srt",
            "1\n00:00:00,000 --> 00:00:01,500\nHello world\n\n\
             2\n00:00:01,500 --> 00:00:03,000\nSecond line\n",
        );
        let segs = import_subtitles(path_str(&p)).unwrap();
        fs::remove_file(&p).ok();
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].text, "Hello world");
        assert_eq!(segs[1].end, 3.0);
    }

    #[test]
    fn command_rejects_wrong_extension() {
        let p = temp_file("notes.txt", "1\n00:00:00,000 --> 00:00:01,000\nHi\n");
        let err = import_subtitles(path_str(&p)).unwrap_err();
        fs::remove_file(&p).ok();
        assert!(err.contains(".srt or .vtt"), "unexpected error: {err}");
    }

    #[test]
    fn command_errors_on_missing_file() {
        let p =
            std::env::temp_dir().join(format!("captionsmith-it-{}-absent.vtt", std::process::id()));
        let err = import_subtitles(path_str(&p)).unwrap_err();
        assert!(err.contains("Could not read"), "unexpected error: {err}");
    }

    #[test]
    fn command_errors_when_file_has_no_cues() {
        let p = temp_file("empty.vtt", "WEBVTT\n\nNOTE just a note\n");
        let err = import_subtitles(path_str(&p)).unwrap_err();
        fs::remove_file(&p).ok();
        assert!(err.contains("No subtitle cues"), "unexpected error: {err}");
    }

    #[test]
    fn imported_segments_round_trip_through_all_exporters() {
        // Parse -> the very segments the exporters serialize on Save / burn-in.
        let segs = parse_subtitles(
            "1\n00:00:00,000 --> 00:00:01,500\nHello world\n\n\
             2\n00:00:01,500 --> 00:00:03,000\nSecond line\n",
        );

        let out_srt = to_srt(&segs);
        assert!(out_srt.contains("00:00:00,000 --> 00:00:01,500"));
        assert!(out_srt.contains("Hello world"));

        let out_vtt = to_vtt(&segs);
        assert!(out_vtt.starts_with("WEBVTT"));
        assert!(out_vtt.contains("00:00:01.500 --> 00:00:03.000"));

        // The ASS the burn-in step feeds to ffmpeg: well-formed, one event/cue.
        let out_ass = to_ass(&segs, &style(), 1920, 1080);
        assert!(out_ass.contains("PlayResY: 1080"));
        assert_eq!(out_ass.matches("Dialogue:").count(), 2);
    }

    #[test]
    fn imported_wordless_cue_under_wordhighlight_stays_plain() {
        // Subtitle files carry no word timings, so word-highlight must degrade to
        // a plain line rather than break the burn-in.
        let segs = parse_subtitles("WEBVTT\n\n00:00:00.000 --> 00:00:02.000\none two three\n");
        assert!(segs[0].words.is_none());

        let mut st = style();
        st.per_word = true;
        st.boxed = false;
        let out = to_ass(&segs, &st, 1920, 1080);

        assert_eq!(out.matches("Dialogue:").count(), 1);
        assert!(!out.contains("\\c&H00F2F245&")); // no per-word highlight override
    }
}
