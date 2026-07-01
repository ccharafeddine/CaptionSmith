#!/usr/bin/env bash
# Build a STATIC, self-contained whisper-cli from source (CMake) and download
# the default model. Static + GGML_NATIVE=OFF => one portable binary that runs
# on any CPU and works as a Tauri externalBin sidecar (no sibling DLLs).
#
# The names match what externalBin expects: whisper-cli-<triple>[.exe].
# Prereqs: CMake + a C/C++ toolchain (MSVC on Windows CI, clang on macOS).
#
# NOTE: unverified on this dev machine (no compiler); exercised in CI (Step 12).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$REPO_ROOT/src-tauri/binaries"
MODEL_DIR="$REPO_ROOT/src-tauri/resources/models"
WORK="${WHISPER_BUILD_DIR:-$REPO_ROOT/.whisper-build}"
WHISPER_TAG="${WHISPER_TAG:-v1.9.1}"
MODEL="ggml-base.en.bin"

mkdir -p "$BIN_DIR" "$MODEL_DIR" "$WORK"

SRC="$WORK/whisper.cpp"
if [ ! -d "$SRC" ]; then
  git clone --depth 1 -b "$WHISPER_TAG" https://github.com/ggml-org/whisper.cpp "$SRC"
fi

# Common flags: static libs, no examples/tests/server we don't ship, and
# GGML_NATIVE=OFF so the binary runs on any CPU (portability over peak speed).
COMMON=(
  -DCMAKE_BUILD_TYPE=Release
  -DBUILD_SHARED_LIBS=OFF
  -DGGML_NATIVE=OFF
  -DWHISPER_BUILD_TESTS=OFF
  -DWHISPER_BUILD_SERVER=OFF
  -DWHISPER_SDL2=OFF
)

echo "== Building static whisper-cli ($WHISPER_TAG) =="
case "$(uname -s)" in
  Darwin)
    cmake -S "$SRC" -B "$SRC/build" "${COMMON[@]}" \
      -DGGML_METAL=OFF \
      -DCMAKE_OSX_ARCHITECTURES="arm64;x86_64"
    cmake --build "$SRC/build" --config Release -j --target whisper-cli
    CLI="$SRC/build/bin/whisper-cli"
    cp "$CLI" "$BIN_DIR/whisper-cli-aarch64-apple-darwin"
    cp "$CLI" "$BIN_DIR/whisper-cli-x86_64-apple-darwin"
    cp "$CLI" "$BIN_DIR/whisper-cli-universal-apple-darwin"
    chmod +x "$BIN_DIR"/whisper-cli-*-apple-darwin
    echo "  -> whisper-cli-{aarch64,x86_64,universal}-apple-darwin"
    ;;
  MINGW* | MSYS* | CYGWIN* | Windows_NT)
    cmake -S "$SRC" -B "$SRC/build" "${COMMON[@]}"
    cmake --build "$SRC/build" --config Release -j --target whisper-cli
    # MSVC multi-config generator puts the exe under Release/.
    CLI="$SRC/build/bin/Release/whisper-cli.exe"
    [ -f "$CLI" ] || CLI="$SRC/build/bin/whisper-cli.exe"
    cp "$CLI" "$BIN_DIR/whisper-cli-x86_64-pc-windows-msvc.exe"
    echo "  -> whisper-cli-x86_64-pc-windows-msvc.exe"
    ;;
  Linux)
    cmake -S "$SRC" -B "$SRC/build" "${COMMON[@]}"
    cmake --build "$SRC/build" -j --target whisper-cli
    cp "$SRC/build/bin/whisper-cli" "$BIN_DIR/whisper-cli-x86_64-unknown-linux-gnu"
    chmod +x "$BIN_DIR/whisper-cli-x86_64-unknown-linux-gnu"
    echo "  -> whisper-cli-x86_64-unknown-linux-gnu"
    ;;
  *)
    echo "Unsupported OS: $(uname -s)" >&2
    exit 1
    ;;
esac

if [ ! -f "$MODEL_DIR/$MODEL" ]; then
  echo "== Downloading $MODEL =="
  curl -fL --retry 3 -o "$MODEL_DIR/$MODEL" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL"
fi

echo "Done."
