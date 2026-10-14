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
    let triple = option_env!("TARGET_TRIPLE").unwrap_or("");
    let (exe_name, dev_name) = file_names(name, triple, cfg!(windows));

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
    if let Some(found) = first_existing(ordered) {
        return Ok(found);
    }

    Err(format!(
        "{name} sidecar not found. Expected it next to the app, or at \
         src-tauri/binaries/{dev_name} for development. Run the scripts/fetch-*.sh."
    ))
}

/// (bundled name, dev name) for a sidecar: the bundle strips the target-triple
/// suffix, the dev `binaries/` layout keeps it. `.exe` on Windows only.
fn file_names(name: &str, triple: &str, windows: bool) -> (String, String) {
    let ext = if windows { ".exe" } else { "" };
    (format!("{name}{ext}"), format!("{name}-{triple}{ext}"))
}

/// The first candidate (in priority order) that exists on disk.
fn first_existing(candidates: impl IntoIterator<Item = Option<PathBuf>>) -> Option<PathBuf> {
    candidates.into_iter().flatten().find(|c| c.exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_platform_and_triple() {
        assert_eq!(
            file_names("yt-dlp", "x86_64-pc-windows-msvc", true),
            (
                "yt-dlp.exe".to_string(),
                "yt-dlp-x86_64-pc-windows-msvc.exe".to_string()
            )
        );
        assert_eq!(
            file_names("whisper-cli", "aarch64-apple-darwin", false),
            (
                "whisper-cli".to_string(),
                "whisper-cli-aarch64-apple-darwin".to_string()
            )
        );
    }

    #[test]
    fn first_existing_respects_order_and_skips_missing() {
        let dir = std::env::temp_dir().join(format!("cs-sidecar-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.bin");
        let b = dir.join("b.bin");
        std::fs::write(&b, b"x").unwrap();
        let only_b = first_existing([Some(a.clone()), None, Some(b.clone())]);
        std::fs::write(&a, b"x").unwrap();
        let a_first = first_existing([Some(a.clone()), Some(b.clone())]);
        let none = first_existing([None, Some(dir.join("missing"))]);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(only_b, Some(b));
        assert_eq!(a_first, Some(a));
        assert_eq!(none, None);
    }

    #[test]
    fn missing_sidecar_error_names_the_dev_path() {
        let err = resolve("definitely-not-a-sidecar").unwrap_err();
        assert!(err.contains("definitely-not-a-sidecar sidecar not found"));
        assert!(err.contains("src-tauri/binaries/definitely-not-a-sidecar-"));
    }
}
