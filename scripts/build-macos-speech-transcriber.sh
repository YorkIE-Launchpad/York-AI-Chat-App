#!/usr/bin/env bash
# Build meeting-speech-transcriber for macOS (SpeechAnalyzer, macOS 26+ SDK).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/native/macos-speech-transcriber/main.swift"
TOOLS="$ROOT/resources/tools"
ARCH="$(uname -m)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[meeting-speech-transcriber] Skipping — not macOS"
  exit 0
fi

if [[ ! -f "$SRC" ]]; then
  echo "[meeting-speech-transcriber] Missing source: $SRC" >&2
  exit 1
fi

case "$ARCH" in
  arm64) DEST_ARCH="arm64"; SWIFT_TRIPLE_ARCH="arm64" ;;
  x86_64) DEST_ARCH="x64"; SWIFT_TRIPLE_ARCH="x86_64" ;;
  *)
    echo "[meeting-speech-transcriber] Unsupported arch: $ARCH" >&2
    exit 1
    ;;
esac

# Pin Mach-O minos to 26.0 (same as Info.plist LSMinimumSystemVersion) so one helper
# binary runs on both macOS 26 and 27+. Without -target, swiftc defaults to the build
# machine's OS (e.g. minos 27.0 on a 27 host) and Launch Services fails open(1) with
# kLSIncompatibleSystemVersionErr (-10825) on macOS 26 / older-SDK Electron.
SPEECH_HELPER_MIN_OS="26.0"
SWIFT_TARGET="${SWIFT_TRIPLE_ARCH}-apple-macos${SPEECH_HELPER_MIN_OS}"
export MACOSX_DEPLOYMENT_TARGET="$SPEECH_HELPER_MIN_OS"

TOOL_ROOT="$TOOLS/darwin-${DEST_ARCH}"
OUT_DIR="$TOOL_ROOT/bin"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/meeting-speech-transcriber"
PLIST="$OUT_DIR/MeetingSpeechTranscriber-Info.plist"

cat > "$PLIST" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>meeting-speech-transcriber</string>
  <key>CFBundleIdentifier</key>
  <string>ie.york.vecos.speech-helper</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>York GrowthOS</string>
  <key>CFBundleDisplayName</key>
  <string>York GrowthOS</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIconName</key>
  <string>AppIcon</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>26.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSSpeechRecognitionUsageDescription</key>
  <string>York GrowthOS uses on-device speech recognition for meeting transcription and chat dictation.</string>
</dict>
</plist>
EOF

PLIST_ABS="$(cd "$(dirname "$PLIST")" && pwd)/$(basename "$PLIST")"

echo "[meeting-speech-transcriber] Compiling for $DEST_ARCH (target $SWIFT_TARGET) → $OUT"
# Embed Info.plist in the binary so TCC sees NSSpeechRecognitionUsageDescription when spawned from Electron.
swiftc -O -whole-module-optimization \
  -target "$SWIFT_TARGET" \
  -framework AppKit \
  -framework AVFoundation \
  -framework Speech \
  -framework Foundation \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$PLIST_ABS" \
  -o "$OUT" \
  "$SRC" || {
  echo "[meeting-speech-transcriber] Build failed — install Xcode with macOS 26 SDK" >&2
  exit 1
}

chmod 755 "$OUT"

APP_ROOT="$TOOL_ROOT/York GrowthOS.app"
# Remove legacy bundle name so the Dock does not show "MeetingSpeechTranscriber".
rm -rf "$TOOL_ROOT/MeetingSpeechTranscriber.app"
APP_MACOS="$APP_ROOT/Contents/MacOS"
APP_RESOURCES="$APP_ROOT/Contents/Resources"
APP_PLIST="$APP_ROOT/Contents/Info.plist"
APP_PKGINFO="$APP_ROOT/Contents/PkgInfo"
ICON_SRC="$ROOT/resources/icon.icns"
mkdir -p "$APP_MACOS" "$APP_RESOURCES"
cp -f "$OUT" "$APP_MACOS/meeting-speech-transcriber"
cp -f "$PLIST" "$APP_PLIST"
printf 'APPL????' > "$APP_PKGINFO"
chmod 755 "$APP_MACOS/meeting-speech-transcriber"

# System Settings → Speech Recognition uses the asset-catalog icon (CFBundleIconName),
# not legacy CFBundleIconFile alone — compile AppIcon into Assets.car.
stage_speech_helper_icon() {
  local icon_src="$1"
  local resources_dir="$2"
  if [[ ! -f "$icon_src" ]]; then
    echo "[meeting-speech-transcriber] Warning: missing $icon_src — helper will use generic icon in Settings" >&2
    return 0
  fi

  local staging
  staging="$(mktemp -d)"
  local iconset="$staging/AppIcon.iconset"
  local appiconset="$staging/Assets.xcassets/AppIcon.appiconset"

  if ! iconutil -c iconset -o "$iconset" "$icon_src" 2>/dev/null; then
    echo "[meeting-speech-transcriber] Warning: iconutil failed — copying icns only" >&2
    cp -f "$icon_src" "$resources_dir/AppIcon.icns"
    rm -rf "$staging"
    return 0
  fi

  mkdir -p "$appiconset"
  cp -f "$iconset"/* "$appiconset/"
  cat > "$appiconset/Contents.json" <<'JSON'
{
  "images": [
    { "size": "16x16", "idiom": "mac", "filename": "icon_16x16.png", "scale": "1x" },
    { "size": "16x16", "idiom": "mac", "filename": "icon_16x16@2x.png", "scale": "2x" },
    { "size": "32x32", "idiom": "mac", "filename": "icon_32x32.png", "scale": "1x" },
    { "size": "32x32", "idiom": "mac", "filename": "icon_32x32@2x.png", "scale": "2x" },
    { "size": "128x128", "idiom": "mac", "filename": "icon_128x128.png", "scale": "1x" },
    { "size": "128x128", "idiom": "mac", "filename": "icon_128x128@2x.png", "scale": "2x" },
    { "size": "256x256", "idiom": "mac", "filename": "icon_256x256.png", "scale": "1x" },
    { "size": "256x256", "idiom": "mac", "filename": "icon_256x256@2x.png", "scale": "2x" },
    { "size": "512x512", "idiom": "mac", "filename": "icon_512x512.png", "scale": "1x" },
    { "size": "512x512", "idiom": "mac", "filename": "icon_512x512@2x.png", "scale": "2x" }
  ],
  "info": { "version": 1, "author": "xcode" }
}
JSON

  if command -v xcrun >/dev/null 2>&1 && xcrun --find actool >/dev/null 2>&1; then
    local actool_out
    actool_out="$(mktemp -d)"
    if xcrun actool --compile "$actool_out" "$staging/Assets.xcassets" \
      --app-icon AppIcon \
      --platform macosx \
      --minimum-deployment-target "$SPEECH_HELPER_MIN_OS" \
      --output-partial-info-plist /dev/null >/dev/null 2>&1; then
      cp -f "$actool_out/AppIcon.icns" "$resources_dir/AppIcon.icns" 2>/dev/null || cp -f "$icon_src" "$resources_dir/AppIcon.icns"
      if [[ -f "$actool_out/Assets.car" ]]; then
        cp -f "$actool_out/Assets.car" "$resources_dir/Assets.car"
      fi
    else
      echo "[meeting-speech-transcriber] Warning: actool failed — copying icns only" >&2
      cp -f "$icon_src" "$resources_dir/AppIcon.icns"
    fi
    rm -rf "$actool_out"
  else
    cp -f "$icon_src" "$resources_dir/AppIcon.icns"
  fi
  rm -rf "$staging"
}

stage_speech_helper_icon "$ICON_SRC" "$APP_RESOURCES"

BUNDLE_ID="ie.york.vecos.speech-helper"
if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - --identifier "$BUNDLE_ID" "$APP_ROOT" || {
    echo "[meeting-speech-transcriber] Warning: codesign failed (TCC may still work with embedded plist)" >&2
  }
fi

LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [[ -x "$LSREGISTER" ]]; then
  "$LSREGISTER" -u "$APP_ROOT" >/dev/null 2>&1 || true
  "$LSREGISTER" -f -R -trusted "$APP_ROOT" >/dev/null 2>&1 || true
fi
if command -v mdimport >/dev/null 2>&1; then
  mdimport "$APP_ROOT" >/dev/null 2>&1 || true
fi
touch "$APP_ROOT"

echo "[meeting-speech-transcriber] Built app bundle: $APP_ROOT"
echo "[meeting-speech-transcriber] Binary: $OUT"
