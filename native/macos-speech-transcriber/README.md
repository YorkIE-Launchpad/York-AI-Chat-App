# meeting-speech-transcriber

On-device meeting transcription helper using **SpeechAnalyzer** + **SpeechTranscriber** (macOS 26+).

## Build

Requires Xcode with the macOS 26 SDK:

```bash
npm run build:speech-transcriber
```

Also runs as part of `npm run build` and `npm run build:s3` (macOS only; no-op on other platforms).

Output:
- `resources/tools/darwin-{arm64|x64}/York GrowthOS.app` (background speech helper — no Dock icon)
- `resources/tools/darwin-{arm64|x64}/bin/meeting-speech-transcriber` (raw binary)

First run: macOS prompts for **Speech Recognition** for **York GrowthOS**. Enable it under System Settings → Privacy & Security → Speech Recognition.

If Settings still shows a generic grid icon after rebuilding, turn **Speech Recognition** off for York GrowthOS, run `npm run build:speech-transcriber` again, then toggle it back on (macOS caches the icon from the first grant).

## Protocol

**stdout:** newline-delimited JSON

- `{"type":"ready"}`
- `{"type":"partial","itemId":"…","text":"…"}`
- `{"type":"final","itemId":"…","text":"…"}`
- `{"type":"error","message":"…"}`

**stdin:** repeated frames: `uint32` little-endian byte length + PCM16 mono audio (16 kHz).

Send `{"cmd":"stop"}\n` as a line (optional) before EOF to finalize.
