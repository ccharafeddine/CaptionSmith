// Speaker diarization (item 6, stage 6a). whisper.cpp transcribes but does NOT
// assign speaker identities, so "who spoke when" comes from a separate ONNX
// pipeline (pyannote segmentation + speaker embedding + clustering) run as the
// bundled `sherpa-onnx-offline-speaker-diarization` sidecar. Its ONNX models are
// downloaded on first use (not bundled) into <AppData>/CaptionSmith/diarization.
//
// This module owns two testable, engine-agnostic pieces — parsing the sidecar's
// speaker-turn output and aligning those turns onto the transcript — plus the
// command that runs the sidecar on the audio. Alignment is where the value is:
// each caption is tagged with the speaker whose turns overlap it most.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;

use crate::ffmpeg;
use crate::proc::Cancellation;
use crate::sidecar;
use crate::transcribe::Segment;

/// Canonical filenames the diarization models are saved under (the downloader
/// renames whatever it fetches to these), so this module doesn't hard-code any
/// upstream model name.
const SEG_MODEL: &str = "segmentation.onnx";
const EMB_MODEL: &str = "embedding.onnx";

// On-first-use model sources (item 6a, increment 3). These are sherpa-onnx's OWN
// converted models — the exact ones the CI verify proved work end to end. The
// segmentation model ships as a .tar.bz2 (extracted via the system tar); the
// embedding model is a direct .onnx.
const SEG_ARCHIVE_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2";
const EMB_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx";

/// Managed state for diarization: a cancel handle for the in-flight run, and a
/// separate flag for cancelling the model download.
#[derive(Default)]
pub struct DiarizeState {
    cancel: Cancellation,
    download_cancel: Arc<AtomicBool>,
}

/// A stretch of audio attributed to one speaker.
#[derive(Debug, Clone, PartialEq)]
struct SpeakerTurn {
    start: f64,
    end: f64,
    speaker: u32,
}

/// Parse the sidecar's stdout. Each result line looks like
/// `0.031 -- 1.743 speaker_00`; anything else (logs, blanks) is skipped.
fn parse_turns(output: &str) -> Vec<SpeakerTurn> {
    let mut turns = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        // Split the trailing "speaker_NN" off the "<start> -- <end>" part.
        let Some((times, spk)) = line.rsplit_once(' ') else {
            continue;
        };
        let Some(idx) = spk.strip_prefix("speaker_") else {
            continue;
        };
        let Ok(speaker) = idx.trim().parse::<u32>() else {
            continue;
        };
        let Some((s, e)) = times.split_once("--") else {
            continue;
        };
        let (Some(start), Some(end)) = (s.trim().parse::<f64>().ok(), e.trim().parse::<f64>().ok())
        else {
            continue;
        };
        if end > start {
            turns.push(SpeakerTurn {
                start,
                end,
                speaker,
            });
        }
    }
    turns
}

/// Overlap (in seconds) of intervals [a0,a1] and [b0,b1]; 0 if disjoint.
fn overlap(a0: f64, a1: f64, b0: f64, b1: f64) -> f64 {
    (a1.min(b1) - a0.max(b0)).max(0.0)
}

/// The speaker whose turns overlap `seg` the most in time. Votes with the
/// segment's words when present (sharper across a turn boundary), else its whole
/// [start,end]. None when nothing overlaps.
fn majority_speaker(seg: &Segment, turns: &[SpeakerTurn]) -> Option<u32> {
    let intervals: Vec<(f64, f64)> = match seg.words.as_ref().filter(|w| !w.is_empty()) {
        Some(words) => words.iter().map(|w| (w.start, w.end)).collect(),
        None => vec![(seg.start, seg.end)],
    };

    let mut totals: HashMap<u32, f64> = HashMap::new();
    for (s, e) in intervals {
        for t in turns {
            let ov = overlap(s, e, t.start, t.end);
            if ov > 0.0 {
                *totals.entry(t.speaker).or_insert(0.0) += ov;
            }
        }
    }

    // Most-overlap wins; on an exact tie prefer the lower speaker index so the
    // result is deterministic.
    totals
        .into_iter()
        .max_by(|a, b| {
            a.1.partial_cmp(&b.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(b.0.cmp(&a.0))
        })
        .map(|(spk, _)| spk)
}

/// Tag every segment with its majority-overlap speaker (or None).
fn assign_speakers(segments: &mut [Segment], turns: &[SpeakerTurn]) {
    for seg in segments.iter_mut() {
        seg.speaker = majority_speaker(seg, turns);
    }
}

fn diarization_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .data_dir()
        .ok()
        .map(|d| d.join("CaptionSmith").join("diarization"))
}

/// Resolve the two ONNX models, or return "DIARIZE_MODELS_MISSING|<dir>" so the
/// frontend can point the user at the download (mirrors the whisper model-missing
/// contract).
fn resolve_models(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let dir = diarization_dir(app)
        .ok_or_else(|| "DIARIZE_MODELS_MISSING|the CaptionSmith diarization folder".to_string())?;
    let seg = dir.join(SEG_MODEL);
    let emb = dir.join(EMB_MODEL);
    if seg.exists() && emb.exists() {
        Ok((seg, emb))
    } else {
        Err(format!("DIARIZE_MODELS_MISSING|{}", dir.display()))
    }
}

#[tauri::command]
pub fn cancel_diarize(state: State<'_, DiarizeState>) {
    state.cancel.cancel();
}

// ---- On-first-use model download --------------------------------------------

#[derive(Clone, Serialize)]
struct DiarizationDownloadProgress {
    /// Human label for the current file ("segmentation model" / "embedding model").
    file: String,
    percent: Option<f64>,
    received: u64,
    total: Option<u64>,
    step: u32,
    steps: u32,
}

/// Whether both diarization models are already downloaded.
#[tauri::command]
pub fn diarization_models_present(app: AppHandle) -> bool {
    resolve_models(&app).is_ok()
}

/// The diarization models folder (created if missing), for the UI.
#[tauri::command]
pub fn diarization_folder(app: AppHandle) -> Result<String, String> {
    let dir = diarization_dir(&app).ok_or("no data directory")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create folder: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn cancel_diarization_download(state: State<'_, DiarizeState>) {
    state.download_cancel.store(true, Ordering::SeqCst);
}

/// Download both ONNX models into the diarization folder (segmentation.onnx +
/// embedding.onnx), streaming "diarization-download-progress" and honouring
/// cancellation. Files already present are skipped, so a cancelled run resumes
/// at file granularity.
#[tauri::command]
pub async fn download_diarization_models(
    app: AppHandle,
    state: State<'_, DiarizeState>,
) -> Result<(), String> {
    let cancel = state.download_cancel.clone();
    cancel.store(false, Ordering::SeqCst);

    let dir = diarization_dir(&app).ok_or("no data directory")?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("create folder: {e}"))?;

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    // 1/2: segmentation model — download the .tar.bz2, extract its model.onnx.
    let seg_dest = dir.join(SEG_MODEL);
    if !seg_dest.exists() {
        let archive = dir.join("segmentation.tar.bz2");
        stream_to_file(
            &app,
            &client,
            &cancel,
            SEG_ARCHIVE_URL,
            &archive,
            "segmentation model",
            1,
        )
        .await?;
        extract_model_onnx(&archive, &seg_dest).await?;
        let _ = tokio::fs::remove_file(&archive).await;
    }

    // 2/2: embedding model — a direct .onnx.
    let emb_dest = dir.join(EMB_MODEL);
    if !emb_dest.exists() {
        stream_to_file(
            &app,
            &client,
            &cancel,
            EMB_URL,
            &emb_dest,
            "embedding model",
            2,
        )
        .await?;
    }

    Ok(())
}

/// Stream `url` to `dest` via a `<dest>.part` temp (so a partial download is
/// never mistaken for a real model), emitting progress and honouring cancel.
async fn stream_to_file(
    app: &AppHandle,
    client: &reqwest::Client,
    cancel: &AtomicBool,
    url: &str,
    dest: &Path,
    label: &str,
    step: u32,
) -> Result<(), String> {
    let part = {
        let mut s = dest.as_os_str().to_owned();
        s.push(".part");
        PathBuf::from(s)
    };

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download failed: HTTP {}", resp.status()));
    }
    let total = resp.content_length();

    let mut out = tokio::fs::File::create(&part)
        .await
        .map_err(|e| format!("could not create file: {e}"))?;
    let mut stream = resp.bytes_stream();
    let mut received: u64 = 0;
    let mut last_emit: u64 = 0;

    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            drop(out);
            let _ = tokio::fs::remove_file(&part).await;
            return Err("cancelled".into());
        }
        let chunk = chunk.map_err(|e| format!("download error: {e}"))?;
        out.write_all(&chunk)
            .await
            .map_err(|e| format!("write error: {e}"))?;
        received += chunk.len() as u64;

        if received - last_emit >= 1_000_000 {
            last_emit = received;
            let percent = total.map(|t| {
                if t > 0 {
                    received as f64 / t as f64 * 100.0
                } else {
                    0.0
                }
            });
            let _ = app.emit(
                "diarization-download-progress",
                DiarizationDownloadProgress {
                    file: label.to_string(),
                    percent,
                    received,
                    total,
                    step,
                    steps: 2,
                },
            );
        }
    }

    out.flush().await.map_err(|e| format!("flush error: {e}"))?;
    drop(out);
    tokio::fs::rename(&part, dest)
        .await
        .map_err(|e| format!("could not finalize download: {e}"))?;
    let _ = app.emit(
        "diarization-download-progress",
        DiarizationDownloadProgress {
            file: label.to_string(),
            percent: Some(100.0),
            received,
            total,
            step,
            steps: 2,
        },
    );
    Ok(())
}

/// Extract `model.onnx` from the segmentation .tar.bz2 to `dest`, using the
/// system `tar` (bsdtar on Windows 10+/macOS both handle bzip2) so we don't need
/// a Rust bzip2/tar decoder.
async fn extract_model_onnx(archive: &Path, dest: &Path) -> Result<(), String> {
    let archive = archive.to_path_buf();
    let dest = dest.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let tmp = archive
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("seg-extract");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).map_err(|e| format!("temp dir: {e}"))?;

        let mut cmd = std::process::Command::new("tar");
        cmd.arg("xf").arg(&archive).arg("-C").arg(&tmp);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let status = cmd
            .status()
            .map_err(|e| format!("could not run tar to extract the model: {e}"))?;
        if !status.success() {
            return Err("could not extract the segmentation model archive.".into());
        }

        let found = find_file(&tmp, "model.onnx").ok_or("model.onnx not found in the archive")?;
        std::fs::copy(&found, &dest).map_err(|e| format!("could not save the model: {e}"))?;
        let _ = std::fs::remove_dir_all(&tmp);
        Ok(())
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

/// Recursively find the first file named `name` under `dir`.
fn find_file(dir: &Path, name: &str) -> Option<PathBuf> {
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let p = entry.path();
        if p.is_dir() {
            if let Some(found) = find_file(&p, name) {
                return Some(found);
            }
        } else if p.file_name().and_then(|n| n.to_str()) == Some(name) {
            return Some(p);
        }
    }
    None
}

/// Run diarization on `src` and return `segments` with each one's `speaker` set.
/// Errors with "DIARIZE_MODELS_MISSING|<dir>" if the models aren't downloaded,
/// or "cancelled" if the user cancels.
#[tauri::command]
pub async fn diarize(
    app: AppHandle,
    state: State<'_, DiarizeState>,
    src: String,
    segments: Vec<Segment>,
) -> Result<Vec<Segment>, String> {
    let bin = sidecar::resolve("sherpa-onnx-offline-speaker-diarization")?;
    let (seg_model, emb_model) = resolve_models(&app)?;

    let cancel = state.cancel.clone();
    cancel.reset();

    tauri::async_runtime::spawn_blocking(move || {
        run_diarize(&app, &cancel, &bin, &seg_model, &emb_model, &src, segments)
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

#[allow(clippy::too_many_arguments)]
fn run_diarize(
    app: &AppHandle,
    cancel: &Cancellation,
    bin: &std::path::Path,
    seg_model: &std::path::Path,
    emb_model: &std::path::Path,
    src: &str,
    mut segments: Vec<Segment>,
) -> Result<Vec<Segment>, String> {
    // Diarization runs on the same 16 kHz mono WAV whisper uses.
    let wav = ffmpeg::extract_to_wav(app, src, cancel)?;
    if cancel.is_cancelled() {
        let _ = std::fs::remove_file(&wav);
        return Err("cancelled".into());
    }

    // Threads are per-model here (there is no top-level --num-threads).
    let t = threads();
    let mut cmd = std::process::Command::new(bin);
    cmd.arg(format!("--segmentation.num-threads={t}"))
        .arg(format!("--embedding.num-threads={t}"))
        .arg(format!(
            "--segmentation.pyannote-model={}",
            seg_model.display()
        ))
        .arg(format!("--embedding.model={}", emb_model.display()))
        // Auto speaker count via a distance threshold (we don't know N up front).
        .arg("--clustering.cluster-threshold=0.5")
        .arg(&wav);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let mut child = cmd.spawn().map_err(|e| {
        let _ = std::fs::remove_file(&wav);
        format!("Failed to start the diarization engine: {e}")
    })?;
    let stdout = child.stdout.take().expect("piped stdout");
    cancel.set_child(child);

    // Turns are printed to stdout, one per line.
    let mut out = String::new();
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        out.push_str(&line);
        out.push('\n');
    }

    let status = match cancel.take_child() {
        Some(mut child) => {
            if cancel.is_cancelled() {
                let _ = child.kill();
            }
            child.wait().map_err(|e| format!("diarization wait: {e}"))?
        }
        None => {
            let _ = std::fs::remove_file(&wav);
            return Err("cancelled".into());
        }
    };
    let _ = std::fs::remove_file(&wav); // zero persistent intermediates

    if cancel.is_cancelled() {
        return Err("cancelled".into());
    }
    if !status.success() {
        return Err("The diarization engine failed on this audio.".into());
    }

    let turns = parse_turns(&out);
    assign_speakers(&mut segments, &turns);
    Ok(segments)
}

fn threads() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(8)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcribe::Word;

    fn seg(start: f64, end: f64) -> Segment {
        Segment {
            start,
            end,
            text: "x".into(),
            words: None,
            speaker: None,
        }
    }

    #[test]
    fn parses_turn_lines_and_skips_noise() {
        let out = "\
Started
0.000 -- 1.500 speaker_00
1.500 -- 3.200 speaker_01
some log line
3.200 -- 4.000 speaker_00
";
        let turns = parse_turns(out);
        assert_eq!(turns.len(), 3);
        assert_eq!(
            turns[0],
            SpeakerTurn {
                start: 0.0,
                end: 1.5,
                speaker: 0
            }
        );
        assert_eq!(turns[1].speaker, 1);
        assert_eq!(
            turns[2],
            SpeakerTurn {
                start: 3.2,
                end: 4.0,
                speaker: 0
            }
        );
    }

    #[test]
    fn skips_zero_and_negative_length_turns() {
        let turns = parse_turns("1.0 -- 1.0 speaker_00\n2.0 -- 1.0 speaker_01\n");
        assert!(turns.is_empty());
    }

    #[test]
    fn assigns_by_majority_overlap() {
        let turns = vec![
            SpeakerTurn {
                start: 0.0,
                end: 2.0,
                speaker: 0,
            },
            SpeakerTurn {
                start: 2.0,
                end: 5.0,
                speaker: 1,
            },
        ];
        // Mostly in speaker 0's turn (0–2 vs a sliver of 1).
        let mut segs = vec![seg(0.0, 2.4), seg(2.4, 5.0)];
        assign_speakers(&mut segs, &turns);
        assert_eq!(segs[0].speaker, Some(0));
        assert_eq!(segs[1].speaker, Some(1));
    }

    #[test]
    fn uses_word_timings_when_present() {
        let turns = vec![
            SpeakerTurn {
                start: 0.0,
                end: 1.0,
                speaker: 0,
            },
            SpeakerTurn {
                start: 1.0,
                end: 3.0,
                speaker: 1,
            },
        ];
        // Segment spans both turns, but its words sit mostly after 1.0 → speaker 1.
        let mut s = seg(0.0, 3.0);
        s.words = Some(vec![
            Word {
                start: 1.1,
                end: 1.6,
                text: "a".into(),
            },
            Word {
                start: 1.6,
                end: 2.4,
                text: "b".into(),
            },
        ]);
        let mut segs = vec![s];
        assign_speakers(&mut segs, &turns);
        assert_eq!(segs[0].speaker, Some(1));
    }

    #[test]
    fn no_overlap_leaves_speaker_none() {
        let turns = vec![SpeakerTurn {
            start: 10.0,
            end: 12.0,
            speaker: 0,
        }];
        let mut segs = vec![seg(0.0, 2.0)];
        assign_speakers(&mut segs, &turns);
        assert_eq!(segs[0].speaker, None);
    }

    #[test]
    fn empty_turns_leaves_all_none() {
        let mut segs = vec![seg(0.0, 1.0), seg(1.0, 2.0)];
        assign_speakers(&mut segs, &[]);
        assert!(segs.iter().all(|s| s.speaker.is_none()));
    }
}
