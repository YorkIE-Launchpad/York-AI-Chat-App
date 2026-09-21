/**
 * Local Y.Doc snapshots for shared chats. The backend relay does not store rooms.
 */
import { getDatabase } from '../db/database';

let schemaReady = false;

function ensureSchema(): void {
  if (schemaReady) return;
  getDatabase().exec(`
    CREATE TABLE IF NOT EXISTS collab_room_snapshots (
      room_id TEXT PRIMARY KEY,
      update_blob BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  schemaReady = true;
}

export function loadCollabRoomSnapshot(roomId: string): Uint8Array | null {
  const id = roomId.trim();
  if (!id) return null;
  try {
    ensureSchema();
    const row = getDatabase()
      .prepare('SELECT update_blob FROM collab_room_snapshots WHERE room_id = ?')
      .get(id) as { update_blob?: Buffer } | undefined;
    if (!row?.update_blob || row.update_blob.length === 0) return null;
    return new Uint8Array(row.update_blob);
  } catch {
    return null;
  }
}

export function saveCollabRoomSnapshot(roomId: string, update: Uint8Array): void {
  const id = roomId.trim();
  if (!id || update.byteLength === 0) return;
  try {
    ensureSchema();
    getDatabase()
      .prepare(
        `INSERT INTO collab_room_snapshots (room_id, update_blob, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(room_id) DO UPDATE SET
           update_blob = excluded.update_blob,
           updated_at = excluded.updated_at`
      )
      .run(id, Buffer.from(update), Date.now());
  } catch {
    // Database may be unavailable in unit tests.
  }
}
