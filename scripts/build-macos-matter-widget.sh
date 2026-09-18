#!/usr/bin/env bash
# Build Matter WidgetKit extension + timeline reload helper for macOS.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$ROOT/native/macos-matter-widget/MatterWidget.xcodeproj"
RELOAD_SRC="$ROOT/native/macos-matter-widget/matter-widget-reload/main.swift"
ARCH="$(uname -m)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[matter-widget] Skipping — not macOS"
  exit 0
fi

if [[ "${SKIP_MATTER_WIDGET:-}" == "1" ]]; then
  echo "[matter-widget] SKIP_MATTER_WIDGET=1 — skipping (packaging continues without PlugIns/MatterWidgetExtension.appex)"
  exit 0
fi

if [[ ! -d "$PROJECT" ]]; then
  echo "[matter-widget] Missing Xcode project: $PROJECT" >&2
  exit 1
fi

case "$ARCH" in
  arm64) DEST_ARCH="arm64" ;;
  x86_64) DEST_ARCH="x64" ;;
  *)
    echo "[matter-widget] Unsupported arch: $ARCH" >&2
    exit 1
    ;;
esac

OUT_WIDGET_ROOT="$ROOT/resources/matter-widget/darwin-${DEST_ARCH}"
DERIVED="$ROOT/.build/matter-widget-${DEST_ARCH}"
mkdir -p "$OUT_WIDGET_ROOT"

ENTITLEMENTS="MatterWidgetExtension/MatterWidgetExtension.entitlements"
XCODE_EXTRA=()
# Do not use APPLE_TEAM_ID from notarization — it is not wired to widget profiles.
# Set MATTER_WIDGET_DEVELOPMENT_TEAM only when App Store / team signing is configured.
WIDGET_TEAM="${MATTER_WIDGET_DEVELOPMENT_TEAM:-}"
if [[ -n "$WIDGET_TEAM" ]]; then
  echo "[matter-widget] Team signing with MATTER_WIDGET_DEVELOPMENT_TEAM=$WIDGET_TEAM"
  XCODE_EXTRA+=(DEVELOPMENT_TEAM="$WIDGET_TEAM")
else
  echo "[matter-widget] Ad-hoc widget build (set MATTER_WIDGET_DEVELOPMENT_TEAM for App Group + team signing)"
  ENTITLEMENTS="MatterWidgetExtension/MatterWidgetExtension.unsigned.entitlements"
  XCODE_EXTRA+=(CODE_SIGN_IDENTITY="-")
fi

echo "[matter-widget] Building extension for $DEST_ARCH …"
XCODEBUILD_ARGS=(
  -project "$PROJECT"
  -scheme MatterWidgetExtension
  -configuration Release
  -derivedDataPath "$DERIVED"
  -destination "generic/platform=macOS"
  ARCHS="${ARCH}"
  CODE_SIGN_ENTITLEMENTS="$ENTITLEMENTS"
  CODE_SIGNING_ALLOWED=YES
  ONLY_ACTIVE_ARCH=NO
)
if [[ -n "$WIDGET_TEAM" && "${MATTER_WIDGET_ALLOW_PROVISIONING_UPDATES:-}" == "1" ]]; then
  XCODEBUILD_ARGS+=(-allowProvisioningUpdates)
fi

if ! xcodebuild "${XCODEBUILD_ARGS[@]}" "${XCODE_EXTRA[@]}" build; then
  if [[ -n "$WIDGET_TEAM" ]]; then
    echo "[matter-widget] Team build failed — retrying ad-hoc (unset MATTER_WIDGET_DEVELOPMENT_TEAM to skip this message)" >&2
    ENTITLEMENTS="MatterWidgetExtension/MatterWidgetExtension.unsigned.entitlements"
    xcodebuild \
      -project "$PROJECT" \
      -scheme MatterWidgetExtension \
      -configuration Release \
      -derivedDataPath "$DERIVED" \
      -destination "generic/platform=macOS" \
      ARCHS="${ARCH}" \
      CODE_SIGN_ENTITLEMENTS="$ENTITLEMENTS" \
      CODE_SIGNING_ALLOWED=YES \
      CODE_SIGN_IDENTITY="-" \
      ONLY_ACTIVE_ARCH=NO \
      build
  else
    exit 1
  fi
fi

APPEX_SRC="$(find "$DERIVED/Build/Products" -name 'MatterWidgetExtension.appex' -type d | head -1)"
if [[ -z "$APPEX_SRC" ]]; then
  echo "[matter-widget] Build succeeded but .appex not found under $DERIVED" >&2
  exit 1
fi

rm -rf "$OUT_WIDGET_ROOT/MatterWidgetExtension.appex"
cp -R "$APPEX_SRC" "$OUT_WIDGET_ROOT/MatterWidgetExtension.appex"
echo "[matter-widget] Staged → $OUT_WIDGET_ROOT/MatterWidgetExtension.appex"

TOOL_BIN="$ROOT/resources/tools/darwin-${DEST_ARCH}/bin"
mkdir -p "$TOOL_BIN"
RELOAD_OUT="$TOOL_BIN/matter-widget-reload"
SYNC_OUT="$TOOL_BIN/matter-widget-sync"
SYNC_SRC="$ROOT/native/macos-matter-widget/matter-widget-sync/main.swift"
SYNC_ENTITLEMENTS="$ROOT/native/macos-matter-widget/matter-widget-sync/MatterWidgetSync.entitlements"
SYNC_ID="ie.york.app.MatterWidgetSync"

echo "[matter-widget] Compiling reload helper → $RELOAD_OUT"
swiftc -O \
  -framework WidgetKit \
  -framework AppKit \
  -o "$RELOAD_OUT" \
  "$RELOAD_SRC"
chmod 755 "$RELOAD_OUT"

echo "[matter-widget] Compiling App Group sync helper → $SYNC_OUT"
swiftc -O \
  -framework WidgetKit \
  -framework Foundation \
  -o "$SYNC_OUT" \
  "$SYNC_SRC"
chmod 755 "$SYNC_OUT"

# Sign sync helper so FileManager can open App Group containers (Node fs cannot).
SIGN_IDENTITY="${CSC_NAME:-${CSC_IDENTITY:-}}"
if [[ -z "$SIGN_IDENTITY" ]]; then
  SIGN_IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' | head -1 || true)"
fi
if [[ -n "$SIGN_IDENTITY" ]] && command -v codesign >/dev/null 2>&1; then
  echo "[matter-widget] codesign sync helper ($SIGN_IDENTITY)"
  if ! codesign --force --options runtime --timestamp \
    --identifier "$SYNC_ID" \
    --entitlements "$SYNC_ENTITLEMENTS" \
    --sign "$SIGN_IDENTITY" \
    "$SYNC_OUT"; then
    echo "[matter-widget] Warning: codesign sync helper failed — widget sync may EPERM until notarize re-signs" >&2
  fi
else
  echo "[matter-widget] Sync helper unsigned here — notarize.js re-signs for release builds"
fi

echo "[matter-widget] Done"
