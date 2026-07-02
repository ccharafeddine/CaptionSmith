#!/usr/bin/env bash
# Build a static, portable, UNIVERSAL (arm64 + x86_64) GPL FFmpeg (+ ffprobe) on
# macOS, with libx264 (the burn-in re-encoder) and libass (subtitle rendering)
# statically linked so the result can be bundled without external dylibs.
#
# There is no suitable prebuilt static GPL FFmpeg for macOS, hence the source
# build. On Windows/Linux, scripts/fetch-ffmpeg.sh grabs the BtbN static build.
#
# The whole dependency chain is built twice — once for the runner's native arch
# and once cross-compiled for the other — into per-arch prefixes, then the two
# ffmpeg/ffprobe binaries are `lipo`-combined into a universal binary. That
# universal binary is written under all three darwin triple names so a
# `--target universal-apple-darwin` Tauri build finds a working sidecar for both
# its x86_64 and aarch64 sub-builds.
#
# Prereqs:  Xcode Command Line Tools, `brew install nasm pkg-config`.
# NOTE: unverified on this dev machine (Windows). Exercised in CI on macos-14.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$REPO_ROOT/src-tauri/binaries"
WORK="${FFMPEG_BUILD_DIR:-$REPO_ROOT/.ffmpeg-build}"
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"
NATIVE_ARCH="$(uname -m)" # arm64 on macos-14

# Source pins (bump as needed).
X264_REV="stable"
FRIBIDI_VER="1.0.16"
FREETYPE_VER="2.13.3"
LIBASS_VER="0.17.3"
FFMPEG_VER="7.1"

mkdir -p "$BIN_DIR" "$WORK"

fetch() { # fetch <url> <tarball>
  [ -f "$WORK/$2" ] || curl -fL --retry 3 -o "$WORK/$2" "$1"
}

echo "== Fetching sources =="
cd "$WORK"
[ -d x264-src ] || git clone --depth 1 -b "$X264_REV" https://code.videolan.org/videolan/x264.git x264-src
fetch "https://github.com/fribidi/fribidi/releases/download/v$FRIBIDI_VER/fribidi-$FRIBIDI_VER.tar.xz" "fribidi.tar.xz"
fetch "https://download.savannah.gnu.org/releases/freetype/freetype-$FREETYPE_VER.tar.xz" "freetype.tar.xz"
fetch "https://github.com/libass/libass/releases/download/$LIBASS_VER/libass-$LIBASS_VER.tar.xz" "libass.tar.xz"
fetch "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VER.tar.xz" "ffmpeg.tar.xz"

# build_chain <clang-arch> : builds the whole chain for one architecture into a
# per-arch prefix, cross-compiling when it isn't the runner's native arch.
build_chain() {
  local ARCH="$1" # arm64 | x86_64
  local HOST FF_ARCH CROSS
  case "$ARCH" in
    arm64) HOST="aarch64-apple-darwin"; FF_ARCH="aarch64" ;;
    x86_64) HOST="x86_64-apple-darwin"; FF_ARCH="x86_64" ;;
    *) echo "unknown arch $ARCH" >&2; exit 1 ;;
  esac
  CROSS=""
  [ "$ARCH" = "$NATIVE_ARCH" ] || CROSS="--enable-cross-compile"

  local PREFIX="$WORK/prefix-$ARCH"
  local B="$WORK/build-$ARCH"
  rm -rf "$PREFIX" "$B"
  mkdir -p "$PREFIX" "$B"

  export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
  export CC="clang -arch $ARCH"
  export CFLAGS="-arch $ARCH -I$PREFIX/include -O2"
  export LDFLAGS="-arch $ARCH -L$PREFIX/lib"

  echo "== [$ARCH] x264 =="
  cp -R x264-src "$B/x264"
  ( cd "$B/x264" && ./configure --prefix="$PREFIX" --host="$HOST" \
      --enable-static --disable-cli --disable-opencl \
    && make -j"$JOBS" && make install )

  echo "== [$ARCH] fribidi =="
  tar -xf fribidi.tar.xz -C "$B"
  ( cd "$B/fribidi-$FRIBIDI_VER" && ./configure --host="$HOST" --prefix="$PREFIX" \
      --enable-static --disable-shared --disable-docs \
    && make -j"$JOBS" && make install )

  echo "== [$ARCH] freetype =="
  tar -xf freetype.tar.xz -C "$B"
  ( cd "$B/freetype-$FREETYPE_VER" && ./configure --host="$HOST" --prefix="$PREFIX" \
      --enable-static --disable-shared \
    && make -j"$JOBS" && make install )

  # HarfBuzz omitted (Meson-only, optional for libass; legacy shaper is fine for
  # Latin/social captions). Re-add via Meson if complex-script shaping is needed.

  echo "== [$ARCH] libass =="
  tar -xf libass.tar.xz -C "$B"
  ( cd "$B/libass-$LIBASS_VER" && ./configure --host="$HOST" --prefix="$PREFIX" \
      --enable-static --disable-shared \
    && make -j"$JOBS" && make install )

  echo "== [$ARCH] ffmpeg =="
  tar -xf ffmpeg.tar.xz -C "$B"
  ( cd "$B/ffmpeg-$FFMPEG_VER" && ./configure \
      --prefix="$PREFIX" \
      --arch="$FF_ARCH" --target-os=darwin $CROSS \
      --cc="clang -arch $ARCH" \
      --pkg-config-flags="--static" \
      --extra-cflags="-arch $ARCH -I$PREFIX/include" \
      --extra-ldflags="-arch $ARCH -L$PREFIX/lib" \
      --enable-gpl --enable-libx264 --enable-libass \
      --enable-static --disable-shared \
      --disable-doc --disable-debug --disable-ffplay \
    && make -j"$JOBS" )

  cp "$B/ffmpeg-$FFMPEG_VER/ffmpeg" "$WORK/ffmpeg-$ARCH"
  cp "$B/ffmpeg-$FFMPEG_VER/ffprobe" "$WORK/ffprobe-$ARCH"
}

build_chain arm64
build_chain x86_64

echo "== lipo -> universal =="
for bin in ffmpeg ffprobe; do
  lipo -create "$WORK/$bin-arm64" "$WORK/$bin-x86_64" -output "$BIN_DIR/$bin-universal-apple-darwin"
  # Name it for every darwin triple: each per-arch sub-build of a universal
  # Tauri bundle looks up its own triple, and a universal binary works for both.
  cp "$BIN_DIR/$bin-universal-apple-darwin" "$BIN_DIR/$bin-aarch64-apple-darwin"
  cp "$BIN_DIR/$bin-universal-apple-darwin" "$BIN_DIR/$bin-x86_64-apple-darwin"
  chmod +x "$BIN_DIR/$bin-"*apple-darwin
  lipo -info "$BIN_DIR/$bin-universal-apple-darwin"
done

echo "Done."
