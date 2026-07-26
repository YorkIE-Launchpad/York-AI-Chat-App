#!/usr/bin/env bash
# Build meeting-mic-probe for macOS and stage into resources/tools.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/native/macos-mic-probe/main.swift"
TOOLS="$ROOT/resources/tools"
ARCH="$(uname -m)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[meeting-mic-probe] Skipping — not macOS"
  exit 0
fi

if [[ ! -f "$SRC" ]]; then
  echo "[meeting-mic-probe] Missing source: $SRC" >&2
  exit 1
fi

case "$ARCH" in
  arm64) DEST_ARCH="arm64" ;;
  x86_64) DEST_ARCH="x64" ;;
  *)
    echo "[meeting-mic-probe] Unsupported arch: $ARCH" >&2
    exit 1
    ;;
esac

OUT_DIR="$TOOLS/darwin-${DEST_ARCH}/bin"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/meeting-mic-probe"

echo "[meeting-mic-probe] Compiling for $DEST_ARCH → $OUT"
swiftc -O -whole-module-optimization \
  -framework CoreAudio \
  -framework AppKit \
  -framework Foundation \
  -o "$OUT" \
  "$SRC"

chmod 755 "$OUT"
echo "[meeting-mic-probe] Built: $OUT"
"$OUT" | head -c 500
echo
