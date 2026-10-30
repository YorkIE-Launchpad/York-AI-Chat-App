import type {
  AppliedCoreMemoryAction,
  CoreMemoryActionInput,
  CoreMemoryEntry,
} from './memory-types';
import {
  applyCoreMemoryActions,
  coreMemoryToPromptBlock,
  loadJsonFile,
  parseCoreCombinedKey,
  saveJsonFile,
} from './memory-utils';

/** Core memory for a chat with no division fields. Not a shared pool. */
export const DEFAULT_CORE_MEMORY_SCOPE = 'vecos://general';

/**
 * core_memory.json version 3. Each workspace division has its own entries,
 * user-written corrections, and forgotten keys. Version 2 was one global map
 * and is not loaded: those entries had no workspace and cannot be split.
 */
interface CoreMemoryScopeFile {
  entries: Record<string, string>;
  written: Record<string, string>;
  forgotten: string[];
}

interface CoreMemoryFile {
  version: 3;
  scopes: Record<string, CoreMemoryScopeFile>;
}

interface ScopeBucket {
  memory: Record<string, string>;
  written: Record<string, string>;
  forgotten: Set<string>;
}

/** The file can be edited by hand, so keys and values are trimmed and blank ones dropped. */
function normalizeValues(value: unknown): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (typeof value !== 'object' || value === null) {
    return normalized;
  }
  for (const [key, item] of Object.entries(value)) {
    const trimmed = typeof item === 'string' ? item.trim() : '';
    if (key.trim() && trimmed) {
      normalized[key.trim()] = trimmed;
    }
  }
  return normalized;
}

function normalizeKeys(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((key) => (typeof key === 'string' ? key.trim() : '')).filter(Boolean)
    : [];
}

function emptyBucket(): ScopeBucket {
  return { memory: {}, written: {}, forgotten: new Set() };
}

export class CoreMemoryStore {
  private readonly scopes = new Map<string, ScopeBucket>();

  constructor(
    private readonly filePath: string,
    private readonly maxItems = 24
  ) {
    const raw = loadJsonFile<Record<string, unknown>>(filePath, {});
    if (raw['version'] !== 3 || typeof raw['scopes'] !== 'object' || raw['scopes'] === null) {
      return;
    }
    for (const [scope, value] of Object.entries(raw['scopes'] as Record<string, unknown>)) {
      const key = scope.trim();
      if (!key || typeof value !== 'object' || value === null) {
        continue;
      }
      const file = value as Record<string, unknown>;
      const bucket = emptyBucket();
      bucket.memory = normalizeValues(file['entries']);
      bucket.written = normalizeValues(file['written']);
      bucket.forgotten = new Set(normalizeKeys(file['forgotten']));
      // Every write keeps forgotten keys out of the entries and the written
      // values in them; a hand-edited file may not, and forgetting wins.
      for (const forgottenKey of bucket.forgotten) {
        delete bucket.memory[forgottenKey];
        delete bucket.written[forgottenKey];
      }
      Object.assign(bucket.memory, bucket.written);
      this.scopes.set(key, bucket);
    }
  }

  getPath(): string {
    return this.filePath;
  }

  listScopes(): string[] {
    return [...this.scopes.keys()];
  }

  getRaw(scope = DEFAULT_CORE_MEMORY_SCOPE): Record<string, string> {
    return { ...(this.peek(scope)?.memory ?? {}) };
  }

  getEntries(scope = DEFAULT_CORE_MEMORY_SCOPE): CoreMemoryEntry[] {
    const bucket = this.peek(scope);
    if (!bucket) {
      return [];
    }
    return Object.entries(bucket.memory).map(([combinedKey, value]) => {
      const parsed = parseCoreCombinedKey(combinedKey);
      return {
        ...parsed,
        value,
      };
    });
  }

  isUserWritten(combinedKey: string, scope = DEFAULT_CORE_MEMORY_SCOPE): boolean {
    const bucket = this.peek(scope);
    return Boolean(bucket && Object.prototype.hasOwnProperty.call(bucket.written, combinedKey));
  }

  /** Extraction results; they never touch forgotten keys or user-written entries. */
  applyActions(
    actions: CoreMemoryActionInput[],
    scope = DEFAULT_CORE_MEMORY_SCOPE
  ): AppliedCoreMemoryAction[] {
    const bucket = this.bucket(scope);
    const result = applyCoreMemoryActions(bucket.memory, actions);
    const nextMemory = { ...result.nextMemory, ...bucket.written };
    for (const key of bucket.forgotten) {
      delete nextMemory[key];
    }
    const applied = result.applied.filter(
      (action) =>
        !bucket.forgotten.has(action.combinedKey) && !this.isUserWritten(action.combinedKey, scope)
    );
    const appliedKeys = new Set(
      applied
        .filter((action) => action.op !== 'delete')
        .map((action) => action.combinedKey)
        .filter((key) => Object.prototype.hasOwnProperty.call(nextMemory, key))
    );
    // User-written entries come first so the size limit never drops them.
    const orderedKeys = [
      ...Object.keys(bucket.written),
      ...appliedKeys,
      ...Object.keys(nextMemory).filter(
        (key) => !appliedKeys.has(key) && !this.isUserWritten(key, scope)
      ),
    ].slice(0, this.maxItems);
    for (const key of Object.keys(bucket.memory)) {
      delete bucket.memory[key];
    }
    for (const key of orderedKeys) {
      if (nextMemory[key] !== undefined) {
        bucket.memory[key] = nextMemory[key];
      }
    }
    this.save();
    return applied;
  }

  /** The user's own value for an entry; extraction and rebuild keep it. */
  writeEntry(combinedKey: string, value: string, scope = DEFAULT_CORE_MEMORY_SCOPE): void {
    const bucket = this.bucket(scope);
    bucket.memory[combinedKey] = value;
    bucket.written[combinedKey] = value;
    bucket.forgotten.delete(combinedKey);
    this.save();
  }

  /** Removes an entry and keeps extraction from adding it back. */
  forgetEntry(combinedKey: string, scope = DEFAULT_CORE_MEMORY_SCOPE): void {
    const bucket = this.bucket(scope);
    delete bucket.memory[combinedKey];
    delete bucket.written[combinedKey];
    bucket.forgotten.add(combinedKey);
    this.save();
  }

  /** Drops extracted entries before a rebuild; the user's corrections stay. */
  clearExtracted(scope?: string): void {
    const scopes = scope ? [this.bucket(scope)] : [...this.scopes.values()];
    for (const bucket of scopes) {
      for (const key of Object.keys(bucket.memory)) {
        if (!Object.prototype.hasOwnProperty.call(bucket.written, key)) {
          delete bucket.memory[key];
        }
      }
    }
    this.save();
  }

  /** Clears one workspace, or every workspace when scope is omitted. */
  clear(scope?: string): void {
    if (scope) {
      this.scopes.delete(scope.trim() || DEFAULT_CORE_MEMORY_SCOPE);
    } else {
      this.scopes.clear();
    }
    this.save();
  }

  toPromptBlock(scope = DEFAULT_CORE_MEMORY_SCOPE): string {
    return coreMemoryToPromptBlock(this.peek(scope)?.memory ?? {});
  }

  save(): void {
    const scopes: Record<string, CoreMemoryScopeFile> = {};
    for (const [scope, bucket] of this.scopes) {
      if (
        !Object.keys(bucket.memory).length &&
        !Object.keys(bucket.written).length &&
        bucket.forgotten.size === 0
      ) {
        continue;
      }
      scopes[scope] = {
        entries: bucket.memory,
        written: bucket.written,
        forgotten: [...bucket.forgotten],
      };
    }
    saveJsonFile(this.filePath, {
      version: 3,
      scopes,
    } satisfies CoreMemoryFile);
  }

  private peek(scope?: string): ScopeBucket | undefined {
    return this.scopes.get(scope?.trim() || DEFAULT_CORE_MEMORY_SCOPE);
  }

  private bucket(scope?: string): ScopeBucket {
    const key = scope?.trim() || DEFAULT_CORE_MEMORY_SCOPE;
    let bucket = this.scopes.get(key);
    if (!bucket) {
      bucket = emptyBucket();
      this.scopes.set(key, bucket);
    }
    return bucket;
  }
}
