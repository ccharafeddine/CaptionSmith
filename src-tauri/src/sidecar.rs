// Resolve a bundled sidecar binary's path for spawning via std::process::Command.
//
// We deliberately do NOT use tauri-plugin-shell's sidecar runner: it inserts a
// `\n` between stdout chunks (plugins-workspace #3090), which corrupts the
// progress streams we parse byte-by-byte. See CLAUDE.md "Gotchas".

use std::path::PathBuf;

/// Locate a sidecar named `name` (e.g. "yt-dlp").
///
/// Order:
/// 1. Next to the running executable — how Tauri lays out `externalBin` in a
///    production bundle (the target-triple suffix is stripped there).
/// 2. `src-tauri/binaries/<name>-<triple>[.exe]` — the dev layout produced by
///    scripts/fetch-*.sh.
pub fn resolve(name: &str) -> Result<PathBuf, String> {
    let exe_name = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(&exe_name);
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }

    let triple = option_env!("TARGET_TRIPLE").unwrap_or("");
    let dev_name = if cfg!(windows) {
        format!("{name}-{triple}.exe")
    } else {
        format!("{name}-{triple}")
    };
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(&dev_name);
    if dev.exists() {
        return Ok(dev);
    }

    Err(format!(
        "{name} sidecar not found. Expected it next to the app, or at \
         src-tauri/binaries/{dev_name} for development. Run scripts/fetch-ytdlp.sh."
    ))
}
