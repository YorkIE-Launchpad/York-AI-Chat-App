# Matter macOS Widget (WidgetKit)

Native desktop widget for York GrowthOS Matter. The Electron main process cannot
write App Group containers directly on modern macOS (`EPERM` even with
`application-groups` entitlements). It pipes JSON to the sandboxed
`matter-widget-sync` helper, which uses `FileManager` container URLs and then
reloads WidgetKit timelines (`matter-widget-reload` remains as a fallback).

## App Groups

Enable both groups on your Apple Developer team (host app + extension + sync helper).
macOS 26+ also requires the **Team-ID-prefixed** forms for sandboxed WidgetKit:

- `group.ie.york.app` / `7G87G26WW6.group.ie.york.app` (packaged `ie.york.app`)
- `group.ie.york.vecos.dev` / `7G87G26WW6.group.ie.york.vecos.dev` (local dev Electron host)

The WidgetKit extension **must** ship with `com.apple.security.app-sandbox` —
without it, `pluginkit`/`chronod` silently ignore the `.appex` and it never
appears in Edit Widgets.

`matter-widget-sync` is a small Developer ID–signed CLI with **application-groups**
(no App Sandbox — sandboxed CLIs outside an `.app` abort at launch). Notarization
re-signs it in `scripts/notarize.js`. Node `fs` to Group Containers still gets
`EPERM`; this helper uses `FileManager` container URLs instead.

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
- `resources/tools/darwin-<arch>/bin/matter-widget-sync`
- `resources/tools/darwin-<arch>/bin/matter-widget-reload`

Packaged apps embed the `.appex` under `Contents/PlugIns/` via electron-builder.

## Add the widget

1. Run or install York GrowthOS (with Matter enabled).
2. macOS **Edit Widgets** → search **Matter** → add Small / Medium / Large.
3. Tap widget rows to open Matter in the app (`yorkgrowthos://` deep links).
