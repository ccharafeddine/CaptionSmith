#!/usr/bin/env bash
# Build a static, portable GPL FFmpeg (+ ffprobe) from source on macOS, with
# libx264 (the burn-in re-encoder) and libass (subtitle rendering) statically
# linked so the result can be bundled without external dylib dependencies.
#
# There is no suitable prebuilt static GPL FFmpeg for macOS, hence the source
# build. On Windows/Linux, scripts/fetch-ffmpeg.sh grabs the BtbN static build
# instead.
#
# Prereqs:  Xcode Command Line Tools, and `brew install nasm pkg-config`.
# Output:   src-tauri/binaries/ffmpeg-<triple>  and  ffprobe-<triple>
#           for aarch64-apple-darwin / x86_64-apple-darwin (host arch), plus a
#           universal-apple-darwin copy. CI (release.yml, Step 12) builds both
#           arches and lipo-combines them into the true universal binary.
#
# NOTE: unverified on this dev machine (Windows). Exercised in CI on macos-14.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$REPO_ROOT/src-tauri/binaries"
WORK="${FFMPEG_BUILD_DIR:-$REPO_ROOT/.ffmpeg-build}"
PREFIX="$WORK/prefix"
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"

# Source pins (bump as needed).
X264_REV="stable"
FRIBIDI_VER="1.0.16"
HARFBUZZ_VER="10.1.0"
FREETYPE_VER="2.13.3"
LIBASS_VER="0.17.3"
FFMPEG_VER="7.1"

mkdir -p "$BIN_DIR" "$WORK" "$PREFIX"
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
export CFLAGS="-I$PREFIX/include -O2"
export LDFLAGS="-L$PREFIX/lib"

fetch() { # fetch <url> <tarball>
  [ -f "$WORK/$2" ] || curl -fL --retry 3 -o "$WORK/$2" "$1"
}

cd "$WORK"

echo "== x264 (static, GPL) =="
if [ ! -d x264 ]; then
  git clone --depth 1 -b "$X264_REV" https://code.videolan.org/videolan/x264.git
fi
( cd x264 && ./configure --prefix="$PREFIX" --enable-static --disable-cli --disable-opencl \
  && make -j"$JOBS" && make install )

echo "== fribidi =="
fetch "https://github.com/fribidi/fribidi/releases/download/v$FRIBIDI_VER/fribidi-$FRIBIDI_VER.tar.xz" "fribidi.tar.xz"
tar -xf fribidi.tar.xz && ( cd "fribidi-$FRIBIDI_VER" \
  && ./configure --prefix="$PREFIX" --enable-static --disable-shared --disable-docs \
  && make -j"$JOBS" && make install )

echo "== freetype =="
fetch "https://download.savannah.gnu.org/releases/freetype/freetype-$FREETYPE_VER.tar.xz" "freetype.tar.xz"
tar -xf freetype.tar.xz && ( cd "freetype-$FREETYPE_VER" \
  && ./configure --prefix="$PREFIX" --enable-static --disable-shared \
  && make -j"$JOBS" && make install )

echo "== harfbuzz =="
fetch "https://github.com/harfbuzz/harfbuzz/releases/download/$HARFBUZZ_VER/harfbuzz-$HARFBUZZ_VER.tar.xz" "harfbuzz.tar.xz"
tar -xf harfbuzz.tar.xz && ( cd "harfbuzz-$HARFBUZZ_VER" \
  && ./configure --prefix="$PREFIX" --enable-static --disable-shared \
  && make -j"$JOBS" && make install )

echo "== libass =="
fetch "https://github.com/libass/libass/releases/download/$LIBASS_VER/libass-$LIBASS_VER.tar.xz" "libass.tar.xz"
tar -xf libass.tar.xz && ( cd "libass-$LIBASS_VER" \
  && ./configure --prefix="$PREFIX" --enable-static --disable-shared \
  && make -j"$JOBS" && make install )

echo "== ffmpeg (GPL, static) =="
fetch "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VER.tar.xz" "ffmpeg.tar.xz"
tar -xf ffmpeg.tar.xz && ( cd "ffmpeg-$FFMPEG_VER" \
  && ./configure \
      --prefix="$PREFIX" \
      --pkg-config-flags="--static" \
      --extra-cflags="-I$PREFIX/include" \
      --extra-ldflags="-L$PREFIX/lib" \
      --enable-gpl \
      --enable-libx264 \
      --enable-libass \
      --enable-static --disable-shared \
      --disable-doc --disable-debug --disable-ffplay \
  && make -j"$JOBS" )

# host arch -> triple
case "$(uname -m)" in
  arm64) TRIPLE="aarch64-apple-darwin" ;;
  x86_64) TRIPLE="x86_64-apple-darwin" ;;
  *) echo "unknown arch $(uname -m)" >&2; exit 1 ;;
esac

for bin in ffmpeg ffprobe; do
  cp "$WORK/ffmpeg-$FFMPEG_VER/$bin" "$BIN_DIR/$bin-$TRIPLE"
  cp "$WORK/ffmpeg-$FFMPEG_VER/$bin" "$BIN_DIR/$bin-universal-apple-darwin"
  chmod +x "$BIN_DIR/$bin-$TRIPLE" "$BIN_DIR/$bin-universal-apple-darwin"
  echo "  -> $bin-$TRIPLE (+ universal copy)"
done

echo "Done. (CI lipo-combines both arches into the true universal binary.)"
