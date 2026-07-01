#!/usr/bin/env bash
# Provide the FFmpeg + ffprobe sidecars (GPL, with libx264 + libass) in
# src-tauri/binaries with the per-target-triple names Tauri's externalBin wants.
#
# Windows/Linux: download the GPL static build from BtbN/FFmpeg-Builds.
# macOS: there is no suitable static GPL build, so delegate to the from-source
#        build script (needs Xcode CLT + `brew install nasm`).
#
# Usage: bash scripts/fetch-ffmpeg.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$REPO_ROOT/src-tauri/binaries"
BASE="https://github.com/BtbN/FFmpeg-Builds/releases/latest/download"

mkdir -p "$BIN_DIR"

place() {
  # place <extracted-file> <dest-basename-with-triple>
  local src="$1" dest="$2"
  [ -n "$src" ] && [ -f "$src" ] || { echo "missing extracted file for $dest" >&2; exit 1; }
  cp "$src" "$BIN_DIR/$dest"
  chmod +x "$BIN_DIR/$dest" 2>/dev/null || true
  echo "  -> $dest"
}

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN* | Windows_NT)
    triple="x86_64-pc-windows-msvc"
    tmp="$(mktemp -d)"
    echo "Downloading FFmpeg GPL static (win64) from BtbN..."
    curl -fL --retry 3 -o "$tmp/ffmpeg.zip" "$BASE/ffmpeg-master-latest-win64-gpl.zip"
    # Git Bash ships GNU tar (no zip support); use PowerShell's Expand-Archive.
    powershell -NoProfile -Command \
      "Expand-Archive -Path '$(cygpath -w "$tmp/ffmpeg.zip")' -DestinationPath '$(cygpath -w "$tmp")' -Force"
    place "$(find "$tmp" -name ffmpeg.exe | head -1)"  "ffmpeg-$triple.exe"
    place "$(find "$tmp" -name ffprobe.exe | head -1)" "ffprobe-$triple.exe"
    rm -rf "$tmp"
    ;;
  Linux)
    triple="x86_64-unknown-linux-gnu"
    tmp="$(mktemp -d)"
    echo "Downloading FFmpeg GPL static (linux64) from BtbN..."
    curl -fL --retry 3 -o "$tmp/ffmpeg.tar.xz" "$BASE/ffmpeg-master-latest-linux64-gpl.tar.xz"
    tar -xf "$tmp/ffmpeg.tar.xz" -C "$tmp"
    place "$(find "$tmp" -name ffmpeg | head -1)"  "ffmpeg-$triple"
    place "$(find "$tmp" -name ffprobe | head -1)" "ffprobe-$triple"
    rm -rf "$tmp"
    ;;
  Darwin)
    echo "macOS: delegating to build-ffmpeg-macos.sh (compiles GPL FFmpeg from source)."
    bash "$REPO_ROOT/scripts/build-ffmpeg-macos.sh"
    ;;
  *)
    echo "Unsupported OS: $(uname -s)" >&2
    exit 1
    ;;
esac

echo "Done."
