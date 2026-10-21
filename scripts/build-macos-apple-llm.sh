#!/usr/bin/env bash
# Build york-apple-llm for macOS (FoundationModels, macOS 26+ SDK).
# The helper lets GrowthOS use the on-device Apple Foundation Model with no
# `sudo fm license` step, which Jamf-managed users cannot perform.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/native/macos-apple-llm/main.swift"
TOOLS="$ROOT/resources/tools"
ARCH="$(uname -m)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[york-apple-llm] Skipping — not macOS"
  exit 0
fi

if [[ ! -f "$SRC" ]]; then
  echo "[york-apple-llm] Missing source: $SRC" >&2
  exit 1
fi

case "$ARCH" in
  arm64) DEST_ARCH="arm64"; SWIFT_TRIPLE_ARCH="arm64" ;;
  x86_64) DEST_ARCH="x64"; SWIFT_TRIPLE_ARCH="x86_64" ;;
  *)
    echo "[york-apple-llm] Unsupported arch: $ARCH" >&2
    exit 1
    ;;
esac

# FoundationModels ships in the macOS 26 SDK; pin minos to 26.0 like the
# speech helper so one binary runs on macOS 26 and 27+.
HELPER_MIN_OS="26.0"
SWIFT_TARGET="${SWIFT_TRIPLE_ARCH}-apple-macos${HELPER_MIN_OS}"
export MACOSX_DEPLOYMENT_TARGET="$HELPER_MIN_OS"

OUT_DIR="$TOOLS/darwin-${DEST_ARCH}/bin"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/york-apple-llm"

echo "[york-apple-llm] Compiling for $DEST_ARCH (target $SWIFT_TARGET) → $OUT"
swiftc -O -whole-module-optimization \
  -target "$SWIFT_TARGET" \
  -framework Foundation \
  -framework FoundationModels \
  -o "$OUT" \
  "$SRC" || {
  echo "[york-apple-llm] Build failed — install Xcode with macOS 26+ SDK" >&2
  exit 1
}

chmod 755 "$OUT"

if command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - --identifier "ie.york.growthos.apple-llm" "$OUT" || {
    echo "[york-apple-llm] Warning: codesign failed (packaged build re-signs resources)" >&2
  }
fi

echo "[york-apple-llm] Built: $OUT"
