// Subtitle serialization: SRT, VTT, and styled ASS.
//
// SRT/VTT are plain (timestamps + the edited transcript text). ASS carries the
// chosen caption style and, for the word-highlight preset, per-word karaoke.
// The ASS generator here is shared with the burn-in export (Step 9): sidecar
// writes it to the user's path; burn-in writes it to a temp file for ffmpeg.
//
// SECURITY/CORRECTNESS: transcript text is sanitized before it enters an ASS
// file so it can't inject override tags or break parsing (CLAUDE.md gotcha).

use serde::Deserialize;

use crate::transcribe::Segment;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionStyle {
    pub preset: String,
    pub font: String,
    pub font_size_pct: f64,
    pub weight: u32,
    pub primary_color: String,
    pub highlight_color: String,
    pub outline: f64,
    pub shadow: bool,
    #[serde(rename = "box")]
    pub boxed: bool,
    pub position: f64,
    pub max_words_per_line: u32,
    pub uppercase: bool,
    pub safe_margin: f64,
}

// ---- time formatting --------------------------------------------------------

fn hms(t: f64) -> (i64, i64, i64, i64) {
    let ms = (t.max(0.0) * 1000.0).round() as i64;
    (ms / 3_600_000, (ms / 60_000) % 60, (ms / 1000) % 60, ms % 1000)
}

fn srt_time(t: f64) -> String {
    let (h, m, s, ms) = hms(t);
    format!("{h:02}:{m:02}:{s:02},{ms:03}")
}

fn vtt_time(t: f64) -> String {
    let (h, m, s, ms) = hms(t);
    format!("{h:02}:{m:02}:{s:02}.{ms:03}")
}

fn ass_time(t: f64) -> String {
    // ASS uses centiseconds: H:MM:SS.cc
    let (h, m, s, ms) = hms(t);
    format!("{h}:{m:02}:{s:02}.{:02}", ms / 10)
}

// ---- SRT / VTT --------------------------------------------------------------

pub fn to_srt(segments: &[Segment]) -> String {
    let mut out = String::new();
    let mut n = 1;
    for seg in segments {
        let text = seg.text.trim();
        if text.is_empty() {
            continue;
        }
        out.push_str(&format!(
            "{n}\n{} --> {}\n{}\n\n",
            srt_time(seg.start),
            srt_time(seg.end),
            text
        ));
        n += 1;
    }
    out
}

pub fn to_vtt(segments: &[Segment]) -> String {
    let mut out = String::from("WEBVTT\n\n");
    for seg in segments {
        let text = seg.text.trim();
        if text.is_empty() {
            continue;
        }
        out.push_str(&format!(
            "{} --> {}\n{}\n\n",
            vtt_time(seg.start),
            vtt_time(seg.end),
            text
        ));
    }
    out
}

// ---- ASS --------------------------------------------------------------------

/// Sanitize transcript text for an ASS field: neutralize override braces and
/// backslashes so nothing in the transcript becomes a style override.
fn ass_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('{', "\\{").replace('}', "\\}")
}

fn cased(s: &str, upper: bool) -> String {
    if upper {
        s.to_uppercase()
    } else {
        s.to_string()
    }
}

/// #rrggbb -> ASS "&H00BBGGRR" (opaque).
fn ass_color(hex: &str) -> String {
    let h = hex.trim_start_matches('#');
    let byte = |i: usize| u8::from_str_radix(h.get(i..i + 2).unwrap_or("ff"), 16).unwrap_or(255);
    let (r, g, b) = if h.len() >= 6 {
        (byte(0), byte(2), byte(4))
    } else {
        (255, 255, 255)
    };
    format!("&H00{b:02X}{g:02X}{r:02X}")
}

/// Join escaped+cased words with spaces, breaking to a new line every `max`.
fn wrap(words: &[String], max: usize) -> String {
    let per = max.max(1);
    let mut out = String::new();
    for (i, w) in words.iter().enumerate() {
        if i > 0 {
            out.push_str(if i % per == 0 { "\\N" } else { " " });
        }
        out.push_str(w);
    }
    out
}

/// Like `wrap`, but wraps word `active` in a highlight-then-reset colour run.
fn wrap_highlight(words: &[String], active: usize, max: usize, pri: &str, hi: &str) -> String {
    let per = max.max(1);
    let mut out = String::new();
    for (i, w) in words.iter().enumerate() {
        if i > 0 {
            out.push_str(if i % per == 0 { "\\N" } else { " " });
        }
        if i == active {
            out.push_str(&format!("{{\\c{hi}&}}{w}{{\\c{pri}&}}"));
        } else {
            out.push_str(w);
        }
    }
    out
}

fn dialogue(start: f64, end: f64, text: &str) -> String {
    format!(
        "Dialogue: 0,{},{},Default,,0,0,0,,{}\n",
        ass_time(start),
        ass_time(end),
        text
    )
}

/// Build a full ASS document from segments + style. `play_w`/`play_h` set the
/// coordinate system (video WxH for burn-in; a 1920x1080 reference for sidecar).
pub fn to_ass(segments: &[Segment], style: &CaptionStyle, play_w: u32, play_h: u32) -> String {
    let fontsize = (style.font_size_pct / 100.0 * play_h as f64).round().max(1.0) as i64;
    let primary = ass_color(&style.primary_color);
    let bold = if style.weight >= 700 { -1 } else { 0 };

    // Box vs outline. libass fills the BorderStyle=3 box from OutlineColour and
    // needs Outline > 0 (the box padding), so Outline=0 renders no box at all.
    // A ~0.6-opacity black box (alpha 0x66; ASS alpha is inverted) matches the
    // HTML preview's rgba(0,0,0,0.6). Otherwise: BorderStyle=1 outline (+shadow).
    let (border_style, outline_col, back_col, outline, shadow): (i64, String, String, i64, i64) =
        if style.boxed {
            let box_col = "&H66000000".to_string();
            let pad = (fontsize as f64 * 0.15).round().max(2.0) as i64;
            (3, box_col.clone(), box_col, pad, 0)
        } else {
            let o = (style.outline * 0.02 * fontsize as f64).round().max(0.0) as i64;
            let shadow = if style.shadow { 2 } else { 0 };
            (1, "&H00000000".to_string(), "&H00000000".to_string(), o, shadow)
        };
    let margin_v = ((100.0 - style.position) / 100.0 * play_h as f64).round().max(0.0) as i64;
    let margin_h = (style.safe_margin / 100.0 * play_w as f64).round().max(0.0) as i64;
    let max = style.max_words_per_line as usize;
    let karaoke = style.preset == "wordHighlight";

    let mut s = String::new();
    s.push_str("[Script Info]\n");
    s.push_str("ScriptType: v4.00+\n");
    s.push_str(&format!("PlayResX: {play_w}\nPlayResY: {play_h}\n"));
    s.push_str("ScaledBorderAndShadow: yes\nWrapStyle: 0\n\n");
    s.push_str("[V4+ Styles]\n");
    s.push_str("Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n");
    s.push_str(&format!(
        "Style: Default,{font},{fontsize},{primary},{primary},{outline_col},{back_col},{bold},0,0,0,100,100,0,0,{border_style},{outline},{shadow},2,{margin_h},{margin_h},{margin_v},1\n\n",
        font = style.font
    ));
    s.push_str("[Events]\n");
    s.push_str("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n");

    for seg in segments {
        if seg.text.trim().is_empty() {
            continue;
        }

        // Word-highlight karaoke: one event per word, the whole line visible
        // with the current word coloured, so only one word "pops" at a time.
        if karaoke {
            if let Some(words) = seg.words.as_ref().filter(|w| !w.is_empty()) {
                let escaped: Vec<String> = words
                    .iter()
                    .map(|w| ass_escape(&cased(w.text.trim(), style.uppercase)))
                    .collect();
                let hi = ass_color(&style.highlight_color);
                for (i, w) in words.iter().enumerate() {
                    let start = w.start;
                    let end = if i + 1 < words.len() {
                        words[i + 1].start
                    } else {
                        seg.end
                    };
                    if end <= start {
                        continue;
                    }
                    let text = wrap_highlight(&escaped, i, max, &primary, &hi);
                    s.push_str(&dialogue(start, end, &text));
                }
                continue;
            }
        }

        let words: Vec<String> = seg
            .text
            .split_whitespace()
            .map(|w| ass_escape(&cased(w, style.uppercase)))
            .collect();
        s.push_str(&dialogue(seg.start, seg.end, &wrap(&words, max)));
    }

    s
}

// ---- command ----------------------------------------------------------------

#[tauri::command]
pub fn export_sidecar(
    segments: Vec<Segment>,
    style: CaptionStyle,
    format: String,
    path: String,
) -> Result<(), String> {
    let content = match format.as_str() {
        "srt" => to_srt(&segments),
        "vtt" => to_vtt(&segments),
        "ass" => to_ass(&segments, &style, 1920, 1080),
        other => return Err(format!("Unknown subtitle format: {other}")),
    };
    if let Some(parent) = std::path::Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&path, content).map_err(|e| format!("Could not write {path}: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(start: f64, end: f64, text: &str) -> Segment {
        Segment { start, end, text: text.to_string(), words: None }
    }

    fn style() -> CaptionStyle {
        CaptionStyle {
            preset: "bottomBar".into(),
            font: "Syne".into(),
            font_size_pct: 5.0,
            weight: 600,
            primary_color: "#ffffff".into(),
            highlight_color: "#45f2f2".into(),
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
    fn srt_shape() {
        let out = to_srt(&[seg(0.0, 1.5, "Hello"), seg(1.5, 2.0, "world")]);
        assert!(out.starts_with("1\n00:00:00,000 --> 00:00:01,500\nHello\n\n2\n"));
    }

    #[test]
    fn vtt_header_and_dot() {
        let out = to_vtt(&[seg(0.0, 1.0, "Hi")]);
        assert!(out.starts_with("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHi\n"));
    }

    #[test]
    fn ass_escapes_override_braces() {
        let out = to_ass(&[seg(0.0, 1.0, "hi {\\an8} there")], &style(), 1920, 1080);
        assert!(out.contains("PlayResY: 1080"));
        assert!(out.contains("\\{"));
        assert!(!out.contains("{\\an8}")); // the raw override must not survive
    }

    #[test]
    fn ass_color_conversion() {
        // #45f2f2 -> &H00 BB GG RR = F2 F2 45
        assert_eq!(ass_color("#45f2f2"), "&H00F2F245");
        assert_eq!(ass_color("#ffffff"), "&H00FFFFFF");
    }
}
