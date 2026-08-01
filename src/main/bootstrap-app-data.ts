/**
 * Must be imported before any electron-store / DB module that reads userData.
 * Sets a separate userData root for local testing (`york-ie-dev`) vs packaged (`york-ie`).
 */
import { app } from 'electron';
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

console.log(`[AppData] env=${appDataEnv} userData=${userDataPath}`);
