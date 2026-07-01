#!/usr/bin/env bash
# Fetch the yt-dlp sidecar into src-tauri/binaries with the per-target-triple
# names Tauri's externalBin expects. Refresh this before every release — yt-dlp
# goes stale as sites change their players.
#
# Usage: bash scripts/fetch-ytdlp.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$REPO_ROOT/src-tauri/binaries"
BASE="https://github.com/yt-dlp/yt-dlp/releases/latest/download"

mkdir -p "$BIN_DIR"

dl() {
  # dl <url> <dest>
  echo "  -> $2"
  curl -fL --retry 3 -o "$2" "$1"
}

echo "Fetching yt-dlp into $BIN_DIR"

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN* | Windows_NT)
    dl "$BASE/yt-dlp.exe" "$BIN_DIR/yt-dlp-x86_64-pc-windows-msvc.exe"
    ;;
  Darwin)
    # yt-dlp_macos is a universal (arm64 + x86_64) binary; name it for each
    # triple we may build, including the universal target used in CI.
    dl "$BASE/yt-dlp_macos" "$BIN_DIR/yt-dlp-aarch64-apple-darwin"
    cp "$BIN_DIR/yt-dlp-aarch64-apple-darwin" "$BIN_DIR/yt-dlp-x86_64-apple-darwin"
    cp "$BIN_DIR/yt-dlp-aarch64-apple-darwin" "$BIN_DIR/yt-dlp-universal-apple-darwin"
    chmod +x "$BIN_DIR"/yt-dlp-*-apple-darwin
    ;;
  Linux)
    # Only needed for local Linux dev runs; not a release target.
    dl "$BASE/yt-dlp" "$BIN_DIR/yt-dlp-x86_64-unknown-linux-gnu"
    chmod +x "$BIN_DIR/yt-dlp-x86_64-unknown-linux-gnu"
    ;;
  *)
    echo "Unsupported OS: $(uname -s)" >&2
    exit 1
    ;;
esac

echo "Done."
