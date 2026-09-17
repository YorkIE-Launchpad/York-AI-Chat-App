# Matter macOS Widget (WidgetKit)

Native desktop widget for York GrowthOS Matter. The Electron main process writes
`matter-widget.json` into the App Group container; this extension reads it and
refreshes on a schedule or when `matter-widget-reload` runs.

## App Groups

Enable both groups on your Apple Developer team (host app + extension):

- `group.ie.york.app` (packaged `ie.york.app`)
- `group.ie.york.vecos.dev` (local dev Electron host)

## Build

```bash
npm run build:matter-widget
```

`npm run build` runs this automatically on macOS. **`APPLE_TEAM_ID` (notarization) is not used** for the widget — that avoids profile errors when you only export notarize credentials. Use team signing only when profiles exist:

```bash
export MATTER_WIDGET_DEVELOPMENT_TEAM=7G87G26WW6
export MATTER_WIDGET_ALLOW_PROVISIONING_UPDATES=1   # optional; needs Xcode Apple ID login
npm run build:matter-widget
```

Skip the widget entirely (e.g. speech-helper-only release): `SKIP_MATTER_WIDGET=1 npm run build`

Notarized releases re-sign (or omit) the ad-hoc `.appex` in `scripts/notarize.js` before `notarytool`. To ship without the desktop widget: `OMIT_MATTER_WIDGET_FOR_NOTARIZE=1 npm run build:s3`

Outputs:

- `resources/matter-widget/darwin-<arch>/MatterWidgetExtension.appex`
- `resources/tools/darwin-<arch>/bin/matter-widget-reload`

Packaged apps embed the `.appex` under `Contents/PlugIns/` via electron-builder.

## Add the widget

1. Run or install York GrowthOS (with Matter enabled).
2. macOS **Edit Widgets** → search **Matter** → add Small / Medium / Large.
3. Tap widget rows to open Matter in the app (`yorkgrowthos://` deep links).
