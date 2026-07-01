// Resolve a bundled sidecar binary's path for spawning via std::process::Command.
//
// We deliberately do NOT use tauri-plugin-shell's sidecar runner: it inserts a
// `\n` between stdout chunks (plugins-workspace #3090), which corrupts the
// progress streams we parse byte-by-byte. See CLAUDE.md "Gotchas".

use std::path::PathBuf;

/// Locate a sidecar named `name` (e.g. "yt-dlp").
///
/// Two candidate locations:
/// - next to the running executable — how Tauri lays out `externalBin` in a
///   production bundle (the target-triple suffix is stripped there);
/// - `src-tauri/binaries/<name>-<triple>[.exe]` — the dev layout from the
///   fetch scripts.
///
/// In DEBUG we try the dev `binaries/` dir first: the local whisper-cli there
/// is the dynamic prebuilt whose sibling DLLs live alongside it, so it must be
/// run from that folder. In RELEASE we try next-to-exe first: CI ships a static,
/// self-contained sidecar there.
pub fn resolve(name: &str) -> Result<PathBuf, String> {
    let exe_name = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    let triple = option_env!("TARGET_TRIPLE").unwrap_or("");
    let dev_name = if cfg!(windows) {
        format!("{name}-{triple}.exe")
    } else {
        format!("{name}-{triple}")
    };

    let next_to_exe = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|d| d.join(&exe_name)));
    let dev = Some(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(&dev_name),
    );

    let ordered: [Option<PathBuf>; 2] = if cfg!(debug_assertions) {
        [dev, next_to_exe]
    } else {
        [next_to_exe, dev]
    };
    for candidate in ordered.into_iter().flatten() {
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(format!(
        "{name} sidecar not found. Expected it next to the app, or at \
         src-tauri/binaries/{dev_name} for development. Run the scripts/fetch-*.sh."
    ))
}
