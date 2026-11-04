#!/usr/bin/env bash
# Build york-voice-hotkey for macOS and stage into resources/tools.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/native/macos-voice-hotkey/main.swift"
TOOLS="$ROOT/resources/tools"
ARCH="$(uname -m)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[york-voice-hotkey] Skipping — not macOS"
  exit 0
fi

if [[ ! -f "$SRC" ]]; then
  echo "[york-voice-hotkey] Missing source: $SRC" >&2
  exit 1
fi

case "$ARCH" in
  arm64) DEST_ARCH="arm64" ;;
  x86_64) DEST_ARCH="x64" ;;
  *)
    echo "[york-voice-hotkey] Unsupported arch: $ARCH" >&2
    exit 1
    ;;
esac

OUT_DIR="$TOOLS/darwin-${DEST_ARCH}/bin"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/york-voice-hotkey"

echo "[york-voice-hotkey] Compiling for $DEST_ARCH → $OUT"
swiftc -O -whole-module-optimization \
  -framework ApplicationServices \
  -framework Carbon \
  -framework CoreGraphics \
  -framework Foundation \
  -o "$OUT" \
  "$SRC"

chmod 755 "$OUT"
echo "[york-voice-hotkey] Built: $OUT"
