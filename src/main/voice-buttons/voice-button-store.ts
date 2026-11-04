/**
 * Per-user SQLite store for voice buttons, dictionary, snippets, history, and usage.
 */
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import {
  defaultVoiceButtonDrafts,
  VOICE_HISTORY_CAP,
  type VoiceButton,
  type VoiceButtonDraft,
  type VoiceDictionaryEntry,
  type VoiceHistoryEntry,
  type VoiceSnippet,
} from '../../shared/voice-buttons';

interface ButtonRow {
  id: string;
  user_sub: string;
  name: string;
  icon: string;
  mode: string;
  rewrite_preset: string | null;
  instruction: string;
  language: string;
  tone: string;
  insert_mode: string;
  sort_order: number;
}

function rowToButton(row: ButtonRow): VoiceButton {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon as VoiceButton['icon'],
    mode: row.mode as VoiceButton['mode'],
    rewritePreset: (row.rewrite_preset as VoiceButton['rewritePreset']) ?? null,
    instruction: row.instruction,
    language: row.language,
    tone: row.tone,
    insertMode: row.insert_mode as VoiceButton['insertMode'],
    sortOrder: row.sort_order,
  };
}

export interface VoiceButtonStore {
  listButtons(userSub: string): VoiceButton[];
  getButton(userSub: string, id: string): VoiceButton | null;
  upsertButton(userSub: string, draft: VoiceButtonDraft): VoiceButton;
  deleteButton(userSub: string, id: string): void;
  reorderButtons(userSub: string, ids: string[]): VoiceButton[];
  duplicateButton(userSub: string, id: string): VoiceButton | null;
  listDictionary(userSub: string): VoiceDictionaryEntry[];
  replaceDictionary(
    userSub: string,
    entries: Array<Pick<VoiceDictionaryEntry, 'term' | 'replacement'>>
  ): VoiceDictionaryEntry[];
  listSnippets(userSub: string): VoiceSnippet[];
  replaceSnippets(
    userSub: string,
    entries: Array<Pick<VoiceSnippet, 'trigger' | 'expansion'>>
  ): VoiceSnippet[];
  addHistory(entry: {
    userSub: string;
    buttonId: string | null;
    buttonName: string;
    rawText: string;
    outputText: string;
    degraded: boolean;
    createdAt: number;
  }): string;
  listHistory(userSub: string, limit?: number): VoiceHistoryEntry[];
  clearHistory(userSub: string): void;
  getUsage(userSub: string, day: string): { utterances: number; audioMs: number };
  tryConsumeUsage(
    userSub: string,
    day: string,
    audioMs: number,
    caps: { utterances: number; audioMs: number }
  ): { allowed: boolean; utterances: number; audioMs: number };
}

export function createVoiceButtonStore(db: Database.Database): VoiceButtonStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS voice_buttons (
      id TEXT PRIMARY KEY,
      user_sub TEXT NOT NULL,
      name TEXT NOT NULL,
      icon TEXT NOT NULL,
      mode TEXT NOT NULL,
      rewrite_preset TEXT,
      instruction TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL DEFAULT 'en',
      tone TEXT NOT NULL DEFAULT 'neutral',
      insert_mode TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_voice_buttons_user ON voice_buttons(user_sub, sort_order);
    CREATE TABLE IF NOT EXISTS voice_button_meta (
      user_sub TEXT PRIMARY KEY,
      seeded INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS voice_dictionary (
      id TEXT PRIMARY KEY,
      user_sub TEXT NOT NULL,
      term TEXT NOT NULL,
      replacement TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_voice_dictionary_user ON voice_dictionary(user_sub);
    CREATE TABLE IF NOT EXISTS voice_snippets (
      id TEXT PRIMARY KEY,
      user_sub TEXT NOT NULL,
      trigger_text TEXT NOT NULL,
      expansion TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_voice_snippets_user ON voice_snippets(user_sub);
    CREATE TABLE IF NOT EXISTS voice_history (
      id TEXT PRIMARY KEY,
      user_sub TEXT NOT NULL,
      button_id TEXT,
      button_name TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      output_text TEXT NOT NULL,
      degraded INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_voice_history_user ON voice_history(user_sub, created_at);
    CREATE TABLE IF NOT EXISTS voice_usage_daily (
      user_sub TEXT NOT NULL,
      day TEXT NOT NULL,
      utterances INTEGER NOT NULL,
      audio_ms INTEGER NOT NULL,
      PRIMARY KEY (user_sub, day)
    );
  `);

  const listButtonsStmt = db.prepare(
    `SELECT id, user_sub, name, icon, mode, rewrite_preset, instruction, language, tone, insert_mode, sort_order
     FROM voice_buttons WHERE user_sub = ? ORDER BY sort_order ASC, created_at ASC`
  );
  const getButtonStmt = db.prepare(
    `SELECT id, user_sub, name, icon, mode, rewrite_preset, instruction, language, tone, insert_mode, sort_order
     FROM voice_buttons WHERE user_sub = ? AND id = ?`
  );
  const seededStmt = db.prepare(`SELECT seeded FROM voice_button_meta WHERE user_sub = ?`);
  const markSeededStmt = db.prepare(
    `INSERT INTO voice_button_meta (user_sub, seeded) VALUES (?, 1)
     ON CONFLICT(user_sub) DO UPDATE SET seeded = 1`
  );

  function ensureDefaults(userSub: string): void {
    const meta = seededStmt.get(userSub) as { seeded: number } | undefined;
    if (meta?.seeded) return;
    const existing = listButtonsStmt.all(userSub) as ButtonRow[];
    if (existing.length === 0) {
      const now = Date.now();
      const insert = db.prepare(
        `INSERT INTO voice_buttons (
          id, user_sub, name, icon, mode, rewrite_preset, instruction, language, tone, insert_mode, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const seed = db.transaction(() => {
        defaultVoiceButtonDrafts().forEach((draft, index) => {
          insert.run(
            uuidv4(),
            userSub,
            draft.name,
            draft.icon,
            draft.mode,
            draft.rewritePreset ?? null,
            draft.instruction ?? '',
            draft.language ?? 'en',
            draft.tone ?? 'neutral',
            draft.insertMode,
            index,
            now,
            now
          );
        });
        markSeededStmt.run(userSub);
      });
      seed();
      return;
    }
    markSeededStmt.run(userSub);
  }

  return {
    listButtons(userSub) {
      ensureDefaults(userSub);
      return (listButtonsStmt.all(userSub) as ButtonRow[]).map(rowToButton);
    },
    getButton(userSub, id) {
      ensureDefaults(userSub);
      const row = getButtonStmt.get(userSub, id) as ButtonRow | undefined;
      return row ? rowToButton(row) : null;
    },
    upsertButton(userSub, draft) {
      ensureDefaults(userSub);
      const now = Date.now();
      if (draft.id) {
        const current = getButtonStmt.get(userSub, draft.id) as ButtonRow | undefined;
        if (!current) {
          throw new Error('Voice button not found');
        }
        db.prepare(
          `UPDATE voice_buttons
           SET name = ?, icon = ?, mode = ?, rewrite_preset = ?, instruction = ?, language = ?, tone = ?, insert_mode = ?, updated_at = ?
           WHERE user_sub = ? AND id = ?`
        ).run(
          draft.name,
          draft.icon,
          draft.mode,
          draft.rewritePreset ?? null,
          draft.instruction ?? '',
          draft.language ?? 'en',
          draft.tone ?? 'neutral',
          draft.insertMode,
          now,
          userSub,
          draft.id
        );
        return rowToButton(getButtonStmt.get(userSub, draft.id) as ButtonRow);
      }
      const id = uuidv4();
      const maxRow = db
        .prepare(
          `SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM voice_buttons WHERE user_sub = ?`
        )
        .get(userSub) as { max_order: number };
      db.prepare(
        `INSERT INTO voice_buttons (
          id, user_sub, name, icon, mode, rewrite_preset, instruction, language, tone, insert_mode, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        userSub,
        draft.name,
        draft.icon,
        draft.mode,
        draft.rewritePreset ?? null,
        draft.instruction ?? '',
        draft.language ?? 'en',
        draft.tone ?? 'neutral',
        draft.insertMode,
        maxRow.max_order + 1,
        now,
        now
      );
      return rowToButton(getButtonStmt.get(userSub, id) as ButtonRow);
    },
    deleteButton(userSub, id) {
      db.prepare(`DELETE FROM voice_buttons WHERE user_sub = ? AND id = ?`).run(userSub, id);
    },
    reorderButtons(userSub, ids) {
      const update = db.prepare(
        `UPDATE voice_buttons SET sort_order = ?, updated_at = ? WHERE user_sub = ? AND id = ?`
      );
      const now = Date.now();
      const apply = db.transaction(() => {
        ids.forEach((id, index) => update.run(index, now, userSub, id));
      });
      apply();
      return (listButtonsStmt.all(userSub) as ButtonRow[]).map(rowToButton);
    },
    duplicateButton(userSub, id) {
      const current = getButtonStmt.get(userSub, id) as ButtonRow | undefined;
      if (!current) return null;
      const copyName = `${current.name} copy`.slice(0, 40);
      return this.upsertButton(userSub, {
        name: copyName,
        icon: current.icon as VoiceButton['icon'],
        mode: current.mode as VoiceButton['mode'],
        rewritePreset: (current.rewrite_preset as VoiceButton['rewritePreset']) ?? null,
        instruction: current.instruction,
        language: current.language,
        tone: current.tone,
        insertMode: current.insert_mode as VoiceButton['insertMode'],
      });
    },
    listDictionary(userSub) {
      const rows = db
        .prepare(
          `SELECT id, term, replacement FROM voice_dictionary WHERE user_sub = ? ORDER BY created_at ASC`
        )
        .all(userSub) as VoiceDictionaryEntry[];
      return rows;
    },
    replaceDictionary(userSub, entries) {
      const now = Date.now();
      const insert = db.prepare(
        `INSERT INTO voice_dictionary (id, user_sub, term, replacement, created_at) VALUES (?, ?, ?, ?, ?)`
      );
      const apply = db.transaction(() => {
        db.prepare(`DELETE FROM voice_dictionary WHERE user_sub = ?`).run(userSub);
        for (const entry of entries) {
          const term = entry.term.trim().slice(0, 80);
          const replacement = entry.replacement.trim().slice(0, 200);
          if (!term || !replacement) continue;
          insert.run(uuidv4(), userSub, term, replacement, now);
        }
      });
      apply();
      return this.listDictionary(userSub);
    },
    listSnippets(userSub) {
      return db
        .prepare(
          `SELECT id, trigger_text AS trigger, expansion FROM voice_snippets WHERE user_sub = ? ORDER BY created_at ASC`
        )
        .all(userSub) as VoiceSnippet[];
    },
    replaceSnippets(userSub, entries) {
      const now = Date.now();
      const insert = db.prepare(
        `INSERT INTO voice_snippets (id, user_sub, trigger_text, expansion, created_at) VALUES (?, ?, ?, ?, ?)`
      );
      const apply = db.transaction(() => {
        db.prepare(`DELETE FROM voice_snippets WHERE user_sub = ?`).run(userSub);
        for (const entry of entries) {
          const trigger = entry.trigger.trim().slice(0, 80);
          const expansion = entry.expansion.trim().slice(0, 2000);
          if (!trigger || !expansion) continue;
          insert.run(uuidv4(), userSub, trigger, expansion, now);
        }
      });
      apply();
      return this.listSnippets(userSub);
    },
    addHistory(entry) {
      const id = uuidv4();
      db.prepare(
        `INSERT INTO voice_history (
          id, user_sub, button_id, button_name, raw_text, output_text, degraded, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        entry.userSub,
        entry.buttonId,
        entry.buttonName,
        entry.rawText.slice(0, 20_000),
        entry.outputText.slice(0, 20_000),
        entry.degraded ? 1 : 0,
        entry.createdAt
      );
      db.prepare(
        `DELETE FROM voice_history WHERE user_sub = ? AND id NOT IN (
          SELECT id FROM voice_history WHERE user_sub = ? ORDER BY created_at DESC LIMIT ?
        )`
      ).run(entry.userSub, entry.userSub, VOICE_HISTORY_CAP);
      return id;
    },
    listHistory(userSub, limit = 50) {
      const rows = db
        .prepare(
          `SELECT id, button_id, button_name, raw_text, output_text, degraded, created_at
           FROM voice_history WHERE user_sub = ? ORDER BY created_at DESC LIMIT ?`
        )
        .all(userSub, Math.min(limit, VOICE_HISTORY_CAP)) as Array<{
        id: string;
        button_id: string | null;
        button_name: string;
        raw_text: string;
        output_text: string;
        degraded: number;
        created_at: number;
      }>;
      return rows.map((row) => ({
        id: row.id,
        buttonId: row.button_id,
        buttonName: row.button_name,
        rawText: row.raw_text,
        outputText: row.output_text,
        degraded: row.degraded === 1,
        createdAt: row.created_at,
      }));
    },
    clearHistory(userSub) {
      db.prepare(`DELETE FROM voice_history WHERE user_sub = ?`).run(userSub);
    },
    getUsage(userSub, day) {
      const row = db
        .prepare(
          `SELECT utterances, audio_ms FROM voice_usage_daily WHERE user_sub = ? AND day = ?`
        )
        .get(userSub, day) as { utterances: number; audio_ms: number } | undefined;
      return { utterances: row?.utterances ?? 0, audioMs: row?.audio_ms ?? 0 };
    },
    tryConsumeUsage(userSub, day, audioMs, caps) {
      const clamped = Math.max(0, Math.min(60_000, Math.round(audioMs)));
      const apply = db.transaction(() => {
        const current = this.getUsage(userSub, day);
        if (current.utterances >= caps.utterances || current.audioMs >= caps.audioMs) {
          return { allowed: false as const, ...current };
        }
        db.prepare(
          `INSERT INTO voice_usage_daily (user_sub, day, utterances, audio_ms)
           VALUES (?, ?, 1, ?)
           ON CONFLICT(user_sub, day) DO UPDATE SET
             utterances = utterances + 1,
             audio_ms = audio_ms + excluded.audio_ms`
        ).run(userSub, day, clamped);
        return { allowed: true as const, ...this.getUsage(userSub, day) };
      });
      return apply();
    },
  };
}
