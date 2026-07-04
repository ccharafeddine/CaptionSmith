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
    # Metal GPU acceleration (item 4a). GGML_METAL_EMBED_LIBRARY bakes the Metal
    # shaders into the binary, so there's still no sibling .metallib to ship and
    # the bundle layout is unchanged. ggml falls back to CPU at runtime when no
    # Metal device is available, so this single universal binary stays safe on
    # every Mac; the app forces CPU with whisper's `-ng` flag when the user turns
    # GPU off. GGML_NATIVE stays OFF (from COMMON) for CPU portability.
    cmake -S "$SRC" -B "$SRC/build" "${COMMON[@]}" \
      -DGGML_METAL=ON \
      -DGGML_METAL_EMBED_LIBRARY=ON \
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
    # CPU build — the portable, always-present fallback.
    cmake -S "$SRC" -B "$SRC/build" "${COMMON[@]}"
    cmake --build "$SRC/build" --config Release -j --target whisper-cli
    # MSVC multi-config generator puts the exe under Release/.
    CLI="$SRC/build/bin/Release/whisper-cli.exe"
    [ -f "$CLI" ] || CLI="$SRC/build/bin/whisper-cli.exe"
    cp "$CLI" "$BIN_DIR/whisper-cli-x86_64-pc-windows-msvc.exe"
    echo "  -> whisper-cli-x86_64-pc-windows-msvc.exe (CPU)"

    # Vulkan GPU build (item 4b) — a SECOND sidecar the app picks at runtime and
    # falls back off when Vulkan isn't available. Needs the Vulkan SDK (glslc,
    # headers, vulkan-1.lib); the GPU binary dynamically loads the system
    # vulkan-1.dll at runtime (shipped by GPU drivers), so nothing extra is
    # bundled. Skipped when no SDK is present (e.g. local dev) so the CPU binary
    # still ships; CI installs the SDK before calling this script.
    if [ -n "${VULKAN_SDK:-}" ] || command -v glslc >/dev/null 2>&1; then
      echo "== Building Vulkan whisper-cli (GPU) =="
      cmake -S "$SRC" -B "$SRC/build-vulkan" "${COMMON[@]}" -DGGML_VULKAN=ON
      cmake --build "$SRC/build-vulkan" --config Release -j --target whisper-cli
      GCLI="$SRC/build-vulkan/bin/Release/whisper-cli.exe"
      [ -f "$GCLI" ] || GCLI="$SRC/build-vulkan/bin/whisper-cli.exe"
      cp "$GCLI" "$BIN_DIR/whisper-cli-gpu-x86_64-pc-windows-msvc.exe"
      echo "  -> whisper-cli-gpu-x86_64-pc-windows-msvc.exe (Vulkan)"
    else
      # Dev fallback (no SDK): copy the CPU binary under the GPU name so the
      # Windows bundle's externalBin existence check still passes and the app
      # runs locally. This is NOT a real GPU build. Release CI always installs
      # the SDK, so it never takes this path (and a failed real Vulkan build
      # errors out under `set -e` rather than being masked here).
      echo "  !! Vulkan SDK not found; using the CPU binary as a whisper-cli-gpu"
      echo "     placeholder (dev only — NOT a real Vulkan build)."
      cp "$BIN_DIR/whisper-cli-x86_64-pc-windows-msvc.exe" \
        "$BIN_DIR/whisper-cli-gpu-x86_64-pc-windows-msvc.exe"
    fi
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
