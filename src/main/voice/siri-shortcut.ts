import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { shell } from 'electron';
import { logWarn } from '../utils/logger';

/**
 * Open the bundled, signed "York" shortcut (one action: open york://voice) so
 * the Shortcuts app shows its "Add Shortcut" sheet. The shortcut name is the
 * Siri phrase: "Hey Siri, York".
 */
export async function installSiriShortcut(
  bundledPath: string
): Promise<{ success: boolean; error?: string }> {
  if (process.platform !== 'darwin') {
    return { success: false, error: 'Siri shortcuts are only available on macOS.' };
  }
  if (!fs.existsSync(bundledPath)) {
    return { success: false, error: 'The York shortcut file is missing from the app bundle.' };
  }
  // Shortcuts names the import after the file, and the bundle is read-only.
  const target = join(os.tmpdir(), 'York.shortcut');
  try {
    fs.copyFileSync(bundledPath, target);
    const error = await shell.openPath(target);
    if (error) return { success: false, error };
    return { success: true };
  } catch (error) {
    logWarn('[Voice] Failed to open Siri shortcut', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
