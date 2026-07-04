#!/usr/bin/env bash
# Fetch the sherpa-onnx offline speaker-diarization sidecar (item 6a). We use the
# STATIC prebuilt exe, which CI (verify-sherpa.yml) confirmed is fully
# self-contained — no onnxruntime.dll to ship — so it drops in as a single
# externalBin sidecar exactly like whisper-cli. Names match externalBin:
# sherpa-onnx-offline-speaker-diarization-<triple>[.exe].
#
# The ONNX MODELS are NOT fetched here: they're downloaded on first use into
# <AppData>/CaptionSmith/diarization (segmentation.onnx + embedding.onnx).
#
# Windows-first: macOS diarization is a follow-up (needs the osx static archive
# name confirmed on a macOS runner) and is not yet wired into externalBin, so the
# macOS branch is a no-op.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$REPO_ROOT/src-tauri/binaries"
VERSION="${SHERPA_VERSION:-1.12.21}"
HF="https://huggingface.co/csukuangfj/sherpa-onnx-libs/resolve/main"
EXE="sherpa-onnx-offline-speaker-diarization"
WORK="${SHERPA_BUILD_DIR:-$REPO_ROOT/.sherpa-build}"

mkdir -p "$BIN_DIR" "$WORK"

# $1 = archive URL, $2 = destination binary path, $3 = exe name inside the archive
fetch_and_extract() {
  local url="$1" out="$2" exe="$3"
  echo "== Fetching $(basename "$url") =="
  curl -fL --retry 3 -o "$WORK/sherpa.tar.bz2" "$url"
  rm -rf "$WORK/x" && mkdir -p "$WORK/x"
  tar xf "$WORK/sherpa.tar.bz2" -C "$WORK/x"
  local found
  found="$(find "$WORK/x" -name "$exe" -type f | head -1)"
  [ -n "$found" ] || {
    echo "!! $exe not found in the archive" >&2
    exit 1
  }
  cp "$found" "$out"
  chmod +x "$out" || true
  echo "  -> $(basename "$out")"
}

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN* | Windows_NT)
    fetch_and_extract \
      "$HF/win64/$VERSION/sherpa-onnx-v$VERSION-win-x64-static.tar.bz2" \
      "$BIN_DIR/$EXE-x86_64-pc-windows-msvc.exe" \
      "$EXE.exe"
    ;;
  Darwin)
    echo "macOS sherpa-onnx diarization sidecar: not yet enabled (follow-up)." >&2
    ;;
  Linux)
    # Local Linux dev only (not a release target).
    fetch_and_extract \
      "$HF/linux/$VERSION/sherpa-onnx-v$VERSION-linux-x64-static.tar.bz2" \
      "$BIN_DIR/$EXE-x86_64-unknown-linux-gnu" \
      "$EXE" || echo "linux sherpa fetch skipped" >&2
    ;;
  *)
    echo "Unsupported OS: $(uname -s)" >&2
    ;;
esac
echo "Done."
