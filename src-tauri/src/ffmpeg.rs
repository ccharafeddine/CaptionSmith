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
use tauri::{AppHandle, Emitter};

use crate::proc::Cancellation;
use crate::sidecar;

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
    p.push(format!("captionsmith-{prefix}-{}-{}.{ext}", std::process::id(), id));
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
pub fn extract_to_wav(app: &AppHandle, src: &str, cancel: &Cancellation) -> Result<PathBuf, String> {
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
            let percent = total.map(|d| if d > 0.0 { (t / d * 100.0).min(100.0) } else { 0.0 });
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

    let _ = app.emit("extract-progress", ExtractProgress { percent: Some(100.0) });
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
