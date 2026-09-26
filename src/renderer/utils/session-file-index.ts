import type { TraceStep } from '../types';
import { isUncPath, isWindowsDrivePath } from '../../shared/local-file-path';
import { resolveArtifactPath } from './artifact-path';
import { extractFilePathFromToolInput, extractFilePathFromToolOutput } from './tool-output-path';

const FILE_TOUCHING_TOOLS = new Set([
  'write',
  'edit',
  'read',
  'write_file',
  'edit_file',
  'read_file',
  'notebookedit',
  'notebook_edit',
  'artifact',
]);

export type SessionFileIndex = {
  /** Absolute paths the agent touched, newest first. */
  paths: string[];
};

function normalizeForCompare(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isAbsoluteLike(value: string): boolean {
  return (
    value.startsWith('/') || value.startsWith('~') || isWindowsDrivePath(value) || isUncPath(value)
  );
}

/** Absolute file paths read/written/edited by the agent in this chat. */
export function buildSessionFileIndex(
  steps: TraceStep[] | undefined,
  cwd?: string | null
): SessionFileIndex {
  const paths: string[] = [];
  const seen = new Set<string>();
  if (!steps?.length) return { paths };

  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (step.status !== 'completed' || step.isError) continue;
    if (!step.toolName || !FILE_TOUCHING_TOOLS.has(step.toolName.toLowerCase())) continue;
    const raw =
      extractFilePathFromToolInput(step.toolInput) ||
      extractFilePathFromToolOutput(step.toolOutput) ||
      '';
    if (!raw) continue;
    const resolved = resolveArtifactPath(raw, cwd);
    const key = normalizeForCompare(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(resolved);
  }
  return { paths };
}

/**
 * Match a bare filename (`SKILL.md`) or relative fragment
 * (`references/01_intro.md`) to a file the agent actually touched.
 */
export function lookupSessionFile(index: SessionFileIndex, value: string): string | null {
  const trimmed = value.trim();
  if (
    !trimmed ||
    index.paths.length === 0 ||
    isAbsoluteLike(trimmed) ||
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
  ) {
    return null;
  }
  const needle = normalizeForCompare(trimmed.replace(/^\.\//, ''));
  if (!needle) return null;
  for (const candidate of index.paths) {
    const normalized = normalizeForCompare(candidate);
    if (normalized === needle || normalized.endsWith(`/${needle}`)) {
      return candidate;
    }
  }
  return null;
}
