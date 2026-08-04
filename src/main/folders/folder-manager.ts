/**
 * Local personal folders under General (Claude/ChatGPT-style user projects).
 */
import { randomUUID } from 'crypto';
import type { DatabaseInstance } from '../db/database';
import type { PersonalFolder } from '../../shared/workspace-division';

export function createFolderManager(db: DatabaseInstance) {
  return {
    list(): PersonalFolder[] {
      return db.folders.list().map(mapFolderRow);
    },

    create(name: string, instructions?: string | null): PersonalFolder {
      const trimmed = name.trim();
      if (!trimmed) {
        throw new Error('Folder name is required');
      }
      const now = Date.now();
      const row = {
        id: randomUUID(),
        name: trimmed,
        instructions: instructions?.trim() || null,
        created_at: now,
        updated_at: now,
      };
      db.folders.create(row);
      return mapFolderRow(row);
    },

    rename(id: string, name: string): PersonalFolder | null {
      const trimmed = name.trim();
      if (!trimmed) {
        throw new Error('Folder name is required');
      }
      const existing = db.folders.get(id);
      if (!existing) return null;
      const updated = {
        ...existing,
        name: trimmed,
        updated_at: Date.now(),
      };
      db.folders.update(id, { name: trimmed, updated_at: updated.updated_at });
      return mapFolderRow(updated);
    },

    updateInstructions(id: string, instructions: string | null): PersonalFolder | null {
      const existing = db.folders.get(id);
      if (!existing) return null;
      const next = instructions?.trim() || null;
      const updatedAt = Date.now();
      db.folders.update(id, { instructions: next, updated_at: updatedAt });
      return mapFolderRow({ ...existing, instructions: next, updated_at: updatedAt });
    },

    delete(id: string): boolean {
      const existing = db.folders.get(id);
      if (!existing) return false;
      db.folders.delete(id);
      return true;
    },

    get(id: string): PersonalFolder | null {
      const row = db.folders.get(id);
      return row ? mapFolderRow(row) : null;
    },
  };
}

export type FolderManager = ReturnType<typeof createFolderManager>;

function mapFolderRow(row: {
  id: string;
  name: string;
  instructions: string | null;
  created_at: number;
  updated_at: number;
}): PersonalFolder {
  return {
    id: row.id,
    name: row.name,
    instructions: row.instructions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
