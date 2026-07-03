// Prompt-only update check. Asks GitHub for the latest published release and
// compares its tag against this build's version. There is NO silent install and
// NO auto-download of a binary — the app only ever tells the user a newer
// version exists and opens the release page in their browser if they choose to.
//
// This is the only network call besides URL import and model download, it is
// user-initiated (or an opt-in startup check), and it sends nothing about the
// user — just a GET with a User-Agent. Keeps the local-first promise intact.

use serde::Serialize;

const RELEASES_URL: &str =
    "https://api.github.com/repos/ccharafeddine/CaptionSmith/releases/latest";

/// Only the release page (never a raw asset) is ever opened, and only if it's an
/// https://github.com/ URL — this keeps `open_release_page` from being a launch-
/// any-URL primitive.
const GITHUB_PREFIX: &str = "https://github.com/";

#[derive(Serialize)]
pub struct UpdateInfo {
    /// This build's version (from Cargo, the single source of truth).
    current: String,
    /// The latest published release's version, tag with any leading `v` stripped.
    latest: String,
    /// True only when `latest` is strictly newer than `current`.
    is_newer: bool,
    /// The release notes (GitHub release body), for showing what's new.
    notes: String,
    /// The release page to open if the user wants to download.
    url: String,
}

/// Split a version like "1.2.3" (or "v1.2.3-beta") into a numeric tuple. Each
/// component keeps only its leading digits, so "3-beta" -> 3 and non-numeric
/// junk -> 0. Missing components compare as 0 (see `version_gt`).
fn parse_version(v: &str) -> Vec<u64> {
    v.trim()
        .trim_start_matches('v')
        .split('.')
        .map(|part| {
            let digits: String = part.chars().take_while(|c| c.is_ascii_digit()).collect();
            digits.parse::<u64>().unwrap_or(0)
        })
        .collect()
}

/// True iff version `a` is strictly newer than `b`, comparing component by
/// component as integers ("1.10.0" > "1.9.9"), padding the shorter with zeros.
fn version_gt(a: &str, b: &str) -> bool {
    let (a, b) = (parse_version(a), parse_version(b));
    let n = a.len().max(b.len());
    for i in 0..n {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    false
}

/// Ask GitHub for the latest release and compare it to this build. Network runs
/// here in Rust (reqwest + rustls), not the webview, so no CSP connect-src is
/// involved. Never downloads or installs anything.
#[tauri::command]
pub async fn check_for_update() -> Result<UpdateInfo, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = client
        .get(RELEASES_URL)
        // GitHub rejects requests without a User-Agent; the Accept header pins
        // the stable v3 JSON schema.
        .header("User-Agent", "CaptionSmith")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Couldn't reach GitHub: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Update check failed: HTTP {}", resp.status()));
    }

    // Parse via text (not resp.json()) so we don't need reqwest's `json` feature.
    let body = resp
        .text()
        .await
        .map_err(|e| format!("Couldn't read the release info: {e}"))?;
    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Couldn't read the release info: {e}"))?;

    let tag = json
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let notes = json
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let url = json
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let latest = tag.trim_start_matches('v').to_string();
    let is_newer = !latest.is_empty() && version_gt(&latest, &current);

    Ok(UpdateInfo {
        current,
        latest,
        is_newer,
        notes,
        url,
    })
}

/// Open the release page in the user's default browser. Restricted to
/// github.com https URLs (the value only ever comes from `check_for_update`),
/// so this can't be abused to launch an arbitrary URL or program.
#[tauri::command]
pub fn open_release_page(url: String) -> Result<(), String> {
    if !url.starts_with(GITHUB_PREFIX) {
        return Err("Refusing to open a non-GitHub URL.".into());
    }

    #[cfg(target_os = "windows")]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("cmd");
        // Empty "" is the window title arg `start` expects before the URL.
        c.args(["/C", "start", "", &url]);
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(&url);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&url);
        c
    };

    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("Couldn't open the browser: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_patch_minor_major() {
        assert!(version_gt("1.0.2", "1.0.1"));
        assert!(version_gt("1.1.0", "1.0.9"));
        assert!(version_gt("2.0.0", "1.9.9"));
        assert!(version_gt("1.10.0", "1.9.0")); // integer, not lexical
    }

    #[test]
    fn equal_or_older_is_not_newer() {
        assert!(!version_gt("1.0.1", "1.0.1"));
        assert!(!version_gt("1.0.0", "1.0.1"));
        assert!(!version_gt("1.9.9", "2.0.0"));
    }

    #[test]
    fn tolerates_v_prefix_and_ragged_lengths() {
        assert!(version_gt("v1.2.0", "1.1.0"));
        assert!(version_gt("1.1", "1.0.9")); // "1.1" -> [1,1] vs [1,0,9]
        assert!(!version_gt("1.0", "1.0.0")); // equal, padded with zeros
        assert!(version_gt("1.0.1", "1.0")); // [1,0,1] vs [1,0,0]
    }

    #[test]
    fn parse_strips_prefix_and_suffix() {
        assert_eq!(parse_version("v1.2.3"), vec![1, 2, 3]);
        assert_eq!(parse_version("1.2.3-beta"), vec![1, 2, 3]);
        assert_eq!(parse_version("1.0.0"), vec![1, 0, 0]);
    }
}
