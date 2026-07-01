// Transcription: extract a 16 kHz WAV, run the bundled whisper-cli sidecar on
// it, parse the JSON into editable segments (optionally with word-level timings
// for karaoke styles), streaming progress and staying cancellable.
//
// Flags were taken from `whisper-cli --help` (v1.9.1), not memorised:
//   -m <model> -f <wav> -of <base> -oj|-ojf -pp -t N -l LANG [-tr]
// whisper writes <base>.json; progress arrives on stderr as "progress = N%".
// The JSON shape (verified empirically):
//   { "transcription": [ { "offsets": {"from":ms,"to":ms}, "text": "...",
//                          "tokens": [ {"text":" And","offsets":{...}}, ... ] } ] }
// Token text carries a leading space at word starts; specials look like [_BEG_].

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::Stdio;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::ffmpeg;
use crate::proc::Cancellation;
use crate::sidecar;

pub const DEFAULT_MODEL: &str = "ggml-base.en.bin";

/// Managed cancel handle for the in-flight transcription.
#[derive(Default)]
pub struct TranscribeState {
    cancel: Cancellation,
}

#[derive(Clone, Serialize)]
pub struct Word {
    start: f64,
    end: f64,
    text: String,
}

#[derive(Clone, Serialize)]
pub struct Segment {
    start: f64,
    end: f64,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    words: Option<Vec<Word>>,
}

#[derive(Clone, Serialize)]
struct TranscribeProgress {
    percent: f64,
}

#[derive(Clone, Serialize)]
pub struct ModelInfo {
    /// Filename to pass back as the `model` arg; empty string = bundled default.
    name: String,
    /// Human label for the picker.
    label: String,
    /// Multilingual models (no ".en" in the name) unlock language pick + translate.
    multilingual: bool,
    /// The bundled default (English base model).
    is_default: bool,
}

/// The known models folder the user can drop custom `ggml-*.bin` files into.
/// Matches the CLAUDE.md pointer: <AppData>/CaptionSmith/models.
fn models_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .data_dir()
        .ok()
        .map(|d| d.join("CaptionSmith").join("models"))
}

/// Resolve the whisper model file. A user-supplied `model` name is looked up in
/// the models folder (or used as an absolute path); otherwise the bundled
/// default is used. On failure returns "MODEL_NOT_FOUND|<models dir>" so the
/// frontend can show a clear pointer instead of a cryptic error.
fn resolve_model(app: &AppHandle, model: Option<&str>) -> Result<PathBuf, String> {
    let not_found = || {
        let dir = models_dir(app)
            .map(|d| d.display().to_string())
            .unwrap_or_else(|| "the CaptionSmith models folder".to_string());
        format!("MODEL_NOT_FOUND|{dir}")
    };

    if let Some(name) = model.map(str::trim).filter(|m| !m.is_empty()) {
        let direct = PathBuf::from(name);
        if direct.is_absolute() && direct.exists() {
            return Ok(direct);
        }
        if let Some(dir) = models_dir(app) {
            let candidate = dir.join(name);
            if candidate.exists() {
                return Ok(candidate);
            }
        }
        return Err(not_found());
    }

    // Bundled default: resource dir in production, source tree in dev.
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("models").join(DEFAULT_MODEL);
        if p.exists() {
            return Ok(p);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("models")
        .join(DEFAULT_MODEL);
    if dev.exists() {
        return Ok(dev);
    }
    Err(not_found())
}

/// Pull the integer percent from a whisper stderr line "... progress =  45%".
fn parse_progress(line: &str) -> Option<f64> {
    let idx = line.find("progress =")?;
    let rest = line[idx + "progress =".len()..].trim_start();
    let pct = rest.find('%')?;
    rest[..pct].trim().parse::<f64>().ok()
}

/// Reconstruct words from whisper's sub-word tokens. A new word starts on a
/// leading-space token; continuation tokens (and attached punctuation) fold
/// into the current word. Special tokens ([_BEG_], [_TT_..]) are skipped.
fn words_from_tokens(tokens: &[serde_json::Value]) -> Option<Vec<Word>> {
    let mut words: Vec<Word> = Vec::new();
    for tok in tokens {
        let raw = tok.get("text").and_then(|t| t.as_str()).unwrap_or("");
        if raw.starts_with("[_") {
            continue;
        }
        let clean = raw.trim();
        if clean.is_empty() {
            continue;
        }
        let from = tok.pointer("/offsets/from").and_then(|v| v.as_f64()).unwrap_or(0.0) / 1000.0;
        let to = tok.pointer("/offsets/to").and_then(|v| v.as_f64()).unwrap_or(0.0) / 1000.0;
        let new_word = raw.starts_with(' ') || words.is_empty();
        if new_word {
            words.push(Word { start: from, end: to, text: clean.to_string() });
        } else if let Some(last) = words.last_mut() {
            last.text.push_str(clean);
            last.end = to;
        }
    }
    if words.is_empty() {
        None
    } else {
        Some(words)
    }
}

fn parse_segments(json: &str, want_words: bool) -> Result<Vec<Segment>, String> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("parse whisper json: {e}"))?;
    let arr = v
        .get("transcription")
        .and_then(|t| t.as_array())
        .ok_or("whisper json missing transcription array")?;

    let mut segments = Vec::with_capacity(arr.len());
    for seg in arr {
        let start = seg.pointer("/offsets/from").and_then(|x| x.as_f64()).unwrap_or(0.0) / 1000.0;
        let end = seg.pointer("/offsets/to").and_then(|x| x.as_f64()).unwrap_or(0.0) / 1000.0;
        let text = seg.get("text").and_then(|t| t.as_str()).unwrap_or("").trim().to_string();
        if text.is_empty() {
            continue;
        }
        let words = if want_words {
            seg.get("tokens").and_then(|t| t.as_array()).and_then(|t| words_from_tokens(t))
        } else {
            None
        };
        segments.push(Segment { start, end, text, words });
    }
    Ok(segments)
}

#[tauri::command]
pub fn cancel_transcribe(state: State<'_, TranscribeState>) {
    state.cancel.cancel();
}

/// List selectable models: the bundled English default (if present) plus any
/// `ggml-*.bin` the user dropped into <AppData>/CaptionSmith/models.
#[tauri::command]
pub fn list_models(app: AppHandle) -> Vec<ModelInfo> {
    let mut models = Vec::new();

    if resolve_model(&app, None).is_ok() {
        models.push(ModelInfo {
            name: String::new(),
            label: "Base · English (bundled)".to_string(),
            multilingual: false,
            is_default: true,
        });
    }

    if let Some(dir) = models_dir(&app) {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("bin") {
                    continue;
                }
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    models.push(ModelInfo {
                        name: name.to_string(),
                        label: name.to_string(),
                        // ".en" in the name marks an English-only model.
                        multilingual: !name.contains(".en."),
                        is_default: false,
                    });
                }
            }
        }
    }

    models
}

/// Transcribe `src`. `language` is a whisper code ("en", "auto", ...);
/// `translate` requests translate-to-English; `word_timestamps` requests
/// per-word timings (slower, only for karaoke styles); `model` overrides the
/// bundled default with a file in the models folder.
#[tauri::command]
pub async fn transcribe(
    app: AppHandle,
    state: State<'_, TranscribeState>,
    src: String,
    language: Option<String>,
    translate: bool,
    word_timestamps: bool,
    model: Option<String>,
) -> Result<Vec<Segment>, String> {
    let whisper = sidecar::resolve("whisper-cli")?;
    let model_path = resolve_model(&app, model.as_deref())?;

    // Clone the shared cancel handle out of managed state before moving into the
    // blocking task (State isn't Send across the await inside spawn_blocking).
    let cancel = state.cancel.clone();
    cancel.reset();

    tauri::async_runtime::spawn_blocking(move || {
        run_transcription(
            &app,
            &cancel,
            &whisper,
            &model_path,
            &src,
            language.as_deref(),
            translate,
            word_timestamps,
        )
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

#[allow(clippy::too_many_arguments)]
fn run_transcription(
    app: &AppHandle,
    cancel: &Cancellation,
    whisper: &std::path::Path,
    model: &std::path::Path,
    src: &str,
    language: Option<&str>,
    translate: bool,
    word_timestamps: bool,
) -> Result<Vec<Segment>, String> {
    // Phase 1: extract the 16 kHz mono WAV (cancellable, emits extract-progress).
    let wav = ffmpeg::extract_to_wav(app, src, cancel)?;
    if cancel.is_cancelled() {
        let _ = std::fs::remove_file(&wav);
        return Err("cancelled".into());
    }

    // Phase 2: run whisper. It writes <out_base>.json.
    let out_base = wav.with_extension("out");
    let json_path = out_base.with_extension("json");

    let cleanup = || {
        let _ = std::fs::remove_file(&wav);
        let _ = std::fs::remove_file(&json_path);
    };

    let mut cmd = std::process::Command::new(whisper);
    cmd.arg("-m").arg(model)
        .arg("-f").arg(&wav)
        .arg("-of").arg(&out_base)
        .arg("-pp")
        .arg("-t").arg(threads().to_string())
        .arg("-l").arg(language.unwrap_or("en"));
    if word_timestamps {
        cmd.arg("-ojf"); // full JSON: per-token offsets for word reconstruction
    } else {
        cmd.arg("-oj");
    }
    if translate {
        cmd.arg("-tr");
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let mut child = cmd.spawn().map_err(|e| {
        cleanup();
        format!("Failed to start whisper: {e}")
    })?;
    let stderr = child.stderr.take().expect("piped stderr");
    cancel.set_child(child);

    let mut tail: Vec<String> = Vec::new();
    for line in BufReader::new(stderr).lines().map_while(Result::ok) {
        if let Some(percent) = parse_progress(&line) {
            let _ = app.emit("transcribe-progress", TranscribeProgress { percent });
        }
        tail.push(line);
        if tail.len() > 20 {
            tail.remove(0);
        }
    }

    let status = match cancel.take_child() {
        Some(mut child) => {
            if cancel.is_cancelled() {
                let _ = child.kill();
            }
            child.wait().map_err(|e| format!("whisper wait: {e}"))?
        }
        None => {
            cleanup();
            return Err("cancelled".into());
        }
    };

    if cancel.is_cancelled() {
        cleanup();
        return Err("cancelled".into());
    }
    if !status.success() {
        cleanup();
        let detail = tail
            .iter()
            .rev()
            .find(|l| l.to_lowercase().contains("error") || l.contains("failed"))
            .cloned()
            .unwrap_or_else(|| "whisper failed to transcribe the audio.".to_string());
        return Err(detail.trim().to_string());
    }

    let json = std::fs::read_to_string(&json_path).map_err(|e| {
        cleanup();
        format!("whisper produced no JSON output: {e}")
    })?;
    let segments = parse_segments(&json, word_timestamps);
    let _ = app.emit("transcribe-progress", TranscribeProgress { percent: 100.0 });
    cleanup(); // zero persistent intermediates (spec)
    segments
}

fn threads() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_progress_lines() {
        assert_eq!(
            parse_progress("whisper_print_progress_callback: progress =  45%"),
            Some(45.0)
        );
        assert_eq!(parse_progress("progress = 100%"), Some(100.0));
        assert_eq!(parse_progress("no progress here"), None);
    }

    #[test]
    fn parses_plain_segments() {
        let json = r#"{"transcription":[
            {"offsets":{"from":0,"to":11000},"text":" Hello world."},
            {"offsets":{"from":11000,"to":13000},"text":" Next line."}
        ]}"#;
        let segs = parse_segments(json, false).unwrap();
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].start, 0.0);
        assert_eq!(segs[0].end, 11.0);
        assert_eq!(segs[0].text, "Hello world.");
        assert!(segs[0].words.is_none());
    }

    #[test]
    fn reconstructs_words_from_tokens() {
        let json = r#"{"transcription":[{"offsets":{"from":0,"to":1000},"text":" And Americans.","tokens":[
            {"text":"[_BEG_]","offsets":{"from":0,"to":0}},
            {"text":" And","offsets":{"from":320,"to":370}},
            {"text":" Americ","offsets":{"from":500,"to":700}},
            {"text":"ans","offsets":{"from":700,"to":820}},
            {"text":".","offsets":{"from":820,"to":840}}
        ]}]}"#;
        let segs = parse_segments(json, true).unwrap();
        let words = segs[0].words.as_ref().unwrap();
        assert_eq!(words.len(), 2);
        assert_eq!(words[0].text, "And");
        assert_eq!(words[0].start, 0.32);
        assert_eq!(words[1].text, "Americans.");
        assert_eq!(words[1].start, 0.5);
        assert_eq!(words[1].end, 0.84);
    }
}
