/**
 * Must be imported before any electron-store / DB module that reads userData.
 * Sets a separate userData root for local testing (`york-ie-dev`) vs packaged (`york-ie`).
 * Also applies the earliest macOS Chromium switches / path overrides so TCC
 * probes never run against the real ~/Music library.
 */
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import {
  APP_DATA_ENV_VAR,
  APP_DATA_NAME_VAR,
  resolveAppDataEnv,
  resolveAppDataName,
} from '../shared/app-data-env';

const appDataEnv = resolveAppDataEnv();
const appDataName = resolveAppDataName();

process.env[APP_DATA_ENV_VAR] = appDataEnv;
process.env[APP_DATA_NAME_VAR] = appDataName;

const userDataPath = path.join(app.getPath('appData'), appDataName);
app.setPath('userData', userDataPath);

if (process.platform === 'darwin') {
  // Chromium's Media Session / Now Playing / global media controls path queries
  // MediaPlayer and triggers an Apple Music / media-library TCC prompt even
  // though this app never uses that API. Apply before any BrowserWindow.
  const existing = app.commandLine.getSwitchValue?.('disable-features') ?? '';
  const required = [
    'MediaSessionService',
    'HardwareMediaKeyHandling',
    'GlobalMediaControls',
  ];
  const merged = [
    ...new Set(
      [...(existing ? existing.split(',') : []), ...required]
        .map((feature) => feature.trim())
        .filter(Boolean)
    ),
  ].join(',');
  app.commandLine.appendSwitch('disable-features', merged);

  // Chromium also probes default ~/Music, ~/Desktop, ~/Downloads paths during
  // init (file picker / download manager). Redirect those into userData so macOS
  // never attributes a Music-library TCC prompt to GrowthOS. Explicit dialogs and
  // agent tools can still reach real user folders when the user asks.
  const safeDir = path.join(userDataPath, 'chromium-default-paths');
  fs.mkdirSync(safeDir, { recursive: true });
  for (const name of ['downloads', 'desktop', 'music', 'pictures', 'videos'] as const) {
    app.setPath(name, safeDir);
  }
}

console.log(`[AppData] env=${appDataEnv} userData=${userDataPath}`);
