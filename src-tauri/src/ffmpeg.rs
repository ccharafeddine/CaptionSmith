// FFmpeg helpers: audio extraction (Step 4) plus the shared stderr progress
// parsing (Duration + time=) that the burn-in export (Step 9) reuses.
//
// Spawned via std::process::Command — never the shell plugin, which corrupts
// the byte streams we parse (#3090). See CLAUDE.md "Gotchas".

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::proc::Cancellation;
use crate::sidecar;
use crate::subtitles::{to_ass, CaptionStyle};
use crate::transcribe::Segment;

static AUDIO_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Serialize)]
struct ExtractProgress {
    /// 0.0–100.0 once a total duration is known, else null (indeterminate).
    percent: Option<f64>,
}

/// Parse an ffmpeg "HH:MM:SS.ss" timestamp into seconds.
fn parse_timestamp(ts: &str) -> Option<f64> {
    let ts = ts.trim();
    let mut parts = ts.split(':');
    let h: f64 = parts.next()?.parse().ok()?;
    let m: f64 = parts.next()?.parse().ok()?;
    let s: f64 = parts.next()?.parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}

/// Pull the seconds value out of an ffmpeg stderr line for a `key=HH:MM:SS.ss`
/// field (e.g. "Duration: 00:01:23.45," or "... time=00:00:12.34 ..."). Returns
/// None if the field is absent or unparseable (ffmpeg emits "time=N/A" early).
fn field_seconds(line: &str, key: &str) -> Option<f64> {
    let start = line.find(key)? + key.len();
    // ffmpeg writes "Duration: 00:.." (leading space) but "time=00:.." (none);
    // trim so the terminator scan lands on the value's own end.
    let rest = line[start..].trim_start();
    let end = rest.find([',', ' ']).unwrap_or(rest.len());
    parse_timestamp(&rest[..end])
}

fn unique_temp_path(prefix: &str, ext: &str) -> PathBuf {
    let id = AUDIO_COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut p = std::env::temp_dir();
    p.push(format!(
        "captionsmith-{prefix}-{}-{}.{ext}",
        std::process::id(),
        id
    ));
    p
}

fn base_command(ffmpeg: &Path) -> Command {
    let mut cmd = Command::new(ffmpeg);
    cmd.arg("-hide_banner").arg("-nostdin").arg("-y");
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: no console flash.
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

/// Extract a 16 kHz mono PCM WAV for whisper. Returns the temp WAV path.
///
/// `ffmpeg -i <src> -vn -ac 1 -ar 16000 -c:a pcm_s16le <tmp.wav>`
///
/// Registers the ffmpeg child with `cancel` so a cancel during this phase kills
/// it. Returns Err("cancelled") if cancelled.
pub fn extract_to_wav(
    app: &AppHandle,
    src: &str,
    cancel: &Cancellation,
) -> Result<PathBuf, String> {
    if !Path::new(src).exists() {
        return Err(format!("Source file not found: {src}"));
    }
    let ffmpeg = sidecar::resolve("ffmpeg")?;
    let out = unique_temp_path("audio", "wav");

    let mut cmd = base_command(&ffmpeg);
    cmd.arg("-i")
        .arg(src)
        .arg("-vn")
        .arg("-ac")
        .arg("1")
        .arg("-ar")
        .arg("16000")
        .arg("-c:a")
        .arg("pcm_s16le")
        .arg(&out);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start ffmpeg: {e}"))?;
    let stderr = child.stderr.take().expect("piped stderr");
    cancel.set_child(child);

    let mut total: Option<f64> = None;
    let mut tail: Vec<String> = Vec::new();
    for line in BufReader::new(stderr).lines().map_while(Result::ok) {
        if total.is_none() {
            if let Some(d) = field_seconds(&line, "Duration:") {
                total = Some(d);
            }
        }
        if let Some(t) = field_seconds(&line, "time=") {
            let percent = total.map(|d| {
                if d > 0.0 {
                    (t / d * 100.0).min(100.0)
                } else {
                    0.0
                }
            });
            let _ = app.emit("extract-progress", ExtractProgress { percent });
        }
        // Keep a small tail for error reporting.
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
            child.wait().map_err(|e| format!("ffmpeg wait: {e}"))?
        }
        None => {
            // cancel already killed and removed the child.
            let _ = std::fs::remove_file(&out);
            return Err("cancelled".into());
        }
    };

    if cancel.is_cancelled() {
        let _ = std::fs::remove_file(&out);
        return Err("cancelled".into());
    }

    if !status.success() {
        let _ = std::fs::remove_file(&out);
        let detail = tail
            .iter()
            .rev()
            .find(|l| l.to_lowercase().contains("error") || l.contains("Invalid"))
            .cloned()
            .unwrap_or_else(|| "ffmpeg could not extract audio from that file.".to_string());
        return Err(detail.trim().to_string());
    }

    let _ = app.emit(
        "extract-progress",
        ExtractProgress {
            percent: Some(100.0),
        },
    );
    Ok(out)
}

/// Tauri command wrapper around `extract_to_wav`. Returns the WAV path.
/// The WAV is a temporary file (OS temp) that the caller is responsible for
/// deleting once transcription has consumed it (Step 5).
#[tauri::command]
pub async fn extract_audio(app: AppHandle, src: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cancel = Cancellation::default();
        extract_to_wav(&app, &src, &cancel).map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

// ---- Burn-in export (Step 9) ------------------------------------------------

/// Managed cancel handle for the in-flight burn-in.
#[derive(Default)]
pub struct BurnState {
    cancel: Cancellation,
}

#[derive(Clone, Serialize)]
struct BurnProgress {
    percent: Option<f64>,
}

/// Probe a video's pixel dimensions and duration via ffprobe.
fn probe_video(ffprobe: &Path, src: &str) -> Result<(u32, u32, f64), String> {
    let mut cmd = Command::new(ffprobe);
    cmd.arg("-v")
        .arg("error")
        .arg("-select_streams")
        .arg("v:0")
        .arg("-show_entries")
        .arg("stream=width,height:format=duration")
        .arg("-of")
        .arg("default=noprint_wrappers=1")
        .arg(src)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }

    let output = cmd.output().map_err(|e| format!("ffprobe failed: {e}"))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let (mut w, mut h, mut dur) = (0u32, 0u32, 0.0f64);
    for line in text.lines() {
        if let Some(v) = line.strip_prefix("width=") {
            w = v.trim().parse().unwrap_or(0);
        } else if let Some(v) = line.strip_prefix("height=") {
            h = v.trim().parse().unwrap_or(0);
        } else if let Some(v) = line.strip_prefix("duration=") {
            dur = v.trim().parse().unwrap_or(0.0);
        }
    }
    if w == 0 || h == 0 {
        return Err("Could not read the video's dimensions.".into());
    }
    Ok((w, h, dur))
}

/// Locate the bundled Syne font so libass can render it (resource dir in a
/// bundle, source tree in dev). Returns None if absent (falls back to system
/// fonts, e.g. when the user picked Arial).
fn bundled_font(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("fonts").join("Syne.ttf");
        if p.exists() {
            return Some(p);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("fonts")
        .join("Syne.ttf");
    dev.exists().then_some(dev)
}

#[tauri::command]
pub fn cancel_burn(state: State<'_, BurnState>) {
    state.cancel.cancel();
}

/// Burn captions into the video: build the .ass from segments+style and run the
/// libx264 re-encode with the ass filter. Emits "burn-progress" and is
/// cancellable. `out` is the user-chosen .mp4 path.
#[tauri::command]
pub async fn burn_in(
    app: AppHandle,
    state: State<'_, BurnState>,
    src: String,
    segments: Vec<Segment>,
    style: CaptionStyle,
    out: String,
) -> Result<(), String> {
    let ffmpeg = sidecar::resolve("ffmpeg")?;
    let ffprobe = sidecar::resolve("ffprobe")?;
    let font = bundled_font(&app);
    let cancel = state.cancel.clone();
    cancel.reset();

    tauri::async_runtime::spawn_blocking(move || {
        run_burn(
            &app,
            &cancel,
            &ffmpeg,
            &ffprobe,
            font.as_deref(),
            &src,
            &segments,
            &style,
            &out,
        )
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

#[allow(clippy::too_many_arguments)]
fn run_burn(
    app: &AppHandle,
    cancel: &Cancellation,
    ffmpeg: &Path,
    ffprobe: &Path,
    font: Option<&Path>,
    src: &str,
    segments: &[Segment],
    style: &CaptionStyle,
    out: &str,
) -> Result<(), String> {
    if !Path::new(src).exists() {
        return Err(format!("Source file not found: {src}"));
    }

    let (w, h, probed_dur) = probe_video(ffprobe, src)?;
    let ass = to_ass(segments, style, w, h);

    // Work in a private temp dir and reference the .ass by BARE filename so the
    // ffmpeg filtergraph never sees a Windows drive colon (which it would parse
    // as an option separator). See progress.txt Step 8 finding.
    let id = AUDIO_COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut work = std::env::temp_dir();
    work.push(format!("captionsmith-burn-{}-{}", std::process::id(), id));
    std::fs::create_dir_all(&work).map_err(|e| format!("temp dir: {e}"))?;
    let ass_name = "captions.ass";
    std::fs::write(work.join(ass_name), ass).map_err(|e| format!("write .ass: {e}"))?;

    // Copy the bundled Syne into a fonts/ subdir and point libass there so it
    // renders even though Syne isn't a system font. (A subdir, not ".", so
    // libass doesn't try to load the .ass itself as a font.) System fonts still
    // resolve via the platform provider.
    if let Some(font) = font {
        let fonts = work.join("fonts");
        if std::fs::create_dir_all(&fonts).is_ok() {
            let _ = std::fs::copy(font, fonts.join("Syne.ttf"));
        }
    }

    let work_clone = work.clone();
    let cleanup = move || {
        let _ = std::fs::remove_dir_all(&work_clone);
    };

    let vf = format!("ass={ass_name}:fontsdir=fonts");
    let mut cmd = base_command(ffmpeg);
    cmd.current_dir(&work)
        .arg("-i")
        .arg(src)
        .arg("-vf")
        .arg(&vf)
        .arg("-c:v")
        .arg("libx264")
        .arg("-crf")
        .arg("18")
        .arg("-preset")
        .arg("medium")
        .arg("-c:a")
        .arg("aac")
        .arg("-b:a")
        .arg("192k")
        .arg("-movflags")
        .arg("+faststart")
        .arg(out);

    let mut child = cmd.spawn().map_err(|e| {
        cleanup();
        format!("Failed to start ffmpeg: {e}")
    })?;
    let stderr = child.stderr.take().expect("piped stderr");
    cancel.set_child(child);

    let mut total = if probed_dur > 0.0 {
        Some(probed_dur)
    } else {
        None
    };
    let mut tail: Vec<String> = Vec::new();
    for line in BufReader::new(stderr).lines().map_while(Result::ok) {
        if total.is_none() {
            if let Some(d) = field_seconds(&line, "Duration:") {
                total = Some(d);
            }
        }
        if let Some(t) = field_seconds(&line, "time=") {
            let percent = total.map(|d| {
                if d > 0.0 {
                    (t / d * 100.0).min(100.0)
                } else {
                    0.0
                }
            });
            let _ = app.emit("burn-progress", BurnProgress { percent });
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
            child.wait().map_err(|e| format!("ffmpeg wait: {e}"))?
        }
        None => {
            cleanup();
            let _ = std::fs::remove_file(out); // drop the partial mp4
            return Err("cancelled".into());
        }
    };

    if cancel.is_cancelled() {
        cleanup();
        let _ = std::fs::remove_file(out);
        return Err("cancelled".into());
    }
    if !status.success() {
        cleanup();
        let _ = std::fs::remove_file(out);
        let detail = tail
            .iter()
            .rev()
            .find(|l| {
                l.to_lowercase().contains("error") || l.contains("Invalid") || l.contains("failed")
            })
            .cloned()
            .unwrap_or_else(|| "ffmpeg could not burn in the captions.".to_string());
        return Err(detail.trim().to_string());
    }

    cleanup();
    let _ = app.emit(
        "burn-progress",
        BurnProgress {
            percent: Some(100.0),
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_timestamps() {
        assert_eq!(parse_timestamp("00:00:12.34"), Some(12.34));
        assert_eq!(parse_timestamp("01:02:03.00"), Some(3723.0));
        assert_eq!(parse_timestamp("N/A"), None);
    }

    #[test]
    fn extracts_fields() {
        let dur = "  Duration: 00:01:23.45, start: 0.000000, bitrate: 1200 kb/s";
        assert_eq!(field_seconds(dur, "Duration:"), Some(83.45));

        let prog = "frame= 100 fps=0.0 q=-1.0 size=1024kB time=00:00:05.00 bitrate=...";
        assert_eq!(field_seconds(prog, "time="), Some(5.0));

        let na = "frame=0 time=N/A bitrate=N/A";
        assert_eq!(field_seconds(na, "time="), None);
    }
}
