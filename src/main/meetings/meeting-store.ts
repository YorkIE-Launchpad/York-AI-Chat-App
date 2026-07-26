import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import type { MeetingsRuntimeConfig } from '../config/config-store';
import { configStore } from '../config/config-store';
import type { MeetingListItem, MeetingPromptContext, MeetingSession } from './meeting-types';

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function safeReadJson<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function toListItem(meeting: MeetingSession): MeetingListItem {
  return {
    id: meeting.id,
    title: meeting.title,
    status: meeting.status,
    createdAt: meeting.createdAt,
    startedAt: meeting.startedAt,
    endedAt: meeting.endedAt,
    durationMs: meeting.durationMs,
    summary: meeting.notes?.summary,
    segmentCount: meeting.segments.length,
    updatedAt: meeting.updatedAt,
  };
}

export class MeetingStore {
  private indexCache: MeetingListItem[] | null = null;

  getStorageRoot(): string {
    const runtime = configStore.get('meetingsRuntime') as MeetingsRuntimeConfig | undefined;
    const configured = runtime?.storageRoot?.trim();
    if (configured) {
      return path.resolve(configured);
    }
    return path.join(app.getPath('userData'), 'meetings');
  }

  private indexPath(): string {
    return path.join(this.getStorageRoot(), 'index.json');
  }

  private meetingPath(id: string): string {
    return path.join(this.getStorageRoot(), 'sessions', `${id}.json`);
  }

  private loadIndex(): MeetingListItem[] {
    if (this.indexCache) {
      return this.indexCache;
    }
    const index = safeReadJson<MeetingListItem[]>(this.indexPath(), []);
    this.indexCache = Array.isArray(index) ? index : [];
    return this.indexCache;
  }

  private saveIndex(items: MeetingListItem[]): void {
    this.indexCache = items;
    writeJson(this.indexPath(), items);
  }

  list(): MeetingListItem[] {
    return [...this.loadIndex()].sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: string): MeetingSession | null {
    return safeReadJson<MeetingSession | null>(this.meetingPath(id), null);
  }

  save(meeting: MeetingSession): MeetingSession {
    writeJson(this.meetingPath(meeting.id), meeting);
    const index = this.loadIndex().filter((item) => item.id !== meeting.id);
    index.unshift(toListItem(meeting));
    this.saveIndex(index);
    return meeting;
  }

  delete(id: string): boolean {
    const filePath = this.meetingPath(id);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    const next = this.loadIndex().filter((item) => item.id !== id);
    this.saveIndex(next);
    return true;
  }

  clearAll(): { success: boolean; deleted: number } {
    const root = this.getStorageRoot();
    const before = this.loadIndex().length;
    if (fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    this.indexCache = [];
    ensureDir(path.join(root, 'sessions'));
    this.saveIndex([]);
    return { success: true, deleted: before };
  }

  search(query: string, limit = 20): MeetingListItem[] {
    const q = query.trim().toLowerCase();
    if (!q) {
      return this.list().slice(0, limit);
    }
    const matches: MeetingListItem[] = [];
    for (const item of this.list()) {
      const meeting = this.get(item.id);
      if (!meeting) continue;
      const haystack = [
        meeting.title,
        meeting.transcriptText,
        meeting.notes?.summary || '',
        ...(meeting.notes?.actionItems || []),
        ...(meeting.notes?.keyTopics || []),
      ]
        .join('\n')
        .toLowerCase();
      if (haystack.includes(q)) {
        matches.push(item);
      }
      if (matches.length >= limit) break;
    }
    return matches;
  }

  getPromptContext(prompt: string, recentCount: number): MeetingPromptContext {
    const ready = this.list().filter((item) => item.status === 'ready');
    const recent = ready.slice(0, Math.max(0, recentCount));
    const q = prompt.trim().toLowerCase();
    const extra: MeetingListItem[] = [];

    if (q) {
      for (const item of ready) {
        if (recent.some((r) => r.id === item.id)) continue;
        const meeting = this.get(item.id);
        if (!meeting) continue;
        const haystack = [
          meeting.title,
          meeting.notes?.summary || '',
          ...(meeting.notes?.keyTopics || []),
          ...(meeting.notes?.actionItems || []),
        ]
          .join('\n')
          .toLowerCase();
        if (haystack.includes(q) || q.includes('meeting') || q.includes('transcript')) {
          extra.push(item);
        }
        if (extra.length >= 3) break;
      }
    }

    const selected = [...recent, ...extra];
    const blocks: string[] = [];
    const meetingIds: string[] = [];

    for (const item of selected) {
      const meeting = this.get(item.id);
      if (!meeting?.notes) continue;
      meetingIds.push(meeting.id);
      const date = new Date(meeting.startedAt).toISOString();
      blocks.push(
        [
          `Meeting id: ${meeting.id}`,
          `Title: ${meeting.notes.title || meeting.title}`,
          `Date: ${date}`,
          `Summary: ${meeting.notes.summary}`,
          meeting.notes.keyTopics.length ? `Key topics: ${meeting.notes.keyTopics.join('; ')}` : '',
          meeting.notes.actionItems.length
            ? `Action items: ${meeting.notes.actionItems.join('; ')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n')
      );
    }

    if (!blocks.length) {
      return { text: '', meetingIds: [] };
    }

    return {
      text: blocks.join('\n\n'),
      meetingIds,
    };
  }
}
