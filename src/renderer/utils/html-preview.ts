import type { TraceStep } from '../types';
import { resolveArtifactPath } from './artifact-path';
import { extractFilePathFromToolInput, extractFilePathFromToolOutput } from './tool-output-path';
import { getArtifactLabel } from './artifact-steps';

const FILE_TOOL_NAMES = new Set([
  'write_file',
  'edit_file',
  'Write',
  'Edit',
  'write',
  'edit',
  'NotebookEdit',
  'notebook_edit',
]);

export type PreviewKind = 'html' | 'markdown';

export type HtmlPreviewCandidate = {
  path: string;
  title?: string;
  kind: PreviewKind;
  /** Stable id of the newest completed step that produced this preview. */
  stepId: string;
};

export function isHtmlPath(pathValue: string | null | undefined): boolean {
  if (!pathValue) {
    return false;
  }
  const normalized = pathValue.trim().replace(/\\/g, '/').toLowerCase();
  return normalized.endsWith('.html') || normalized.endsWith('.htm');
}

export function isMarkdownPath(pathValue: string | null | undefined): boolean {
  if (!pathValue) {
    return false;
  }
  const normalized = pathValue.trim().replace(/\\/g, '/').toLowerCase();
  return normalized.endsWith('.md') || normalized.endsWith('.markdown');
}

export function isPreviewablePath(pathValue: string | null | undefined): boolean {
  return isHtmlPath(pathValue) || isMarkdownPath(pathValue);
}

export function previewKindFromPath(pathValue: string | null | undefined): PreviewKind | null {
  if (isHtmlPath(pathValue)) {
    return 'html';
  }
  if (isMarkdownPath(pathValue)) {
    return 'markdown';
  }
  return null;
}

function parseArtifactToolOutput(toolOutput: string | undefined): {
  path: string;
  title?: string;
  kind: PreviewKind;
} | null {
  if (!toolOutput) {
    return null;
  }
  try {
    const parsed = JSON.parse(toolOutput) as Record<string, unknown>;
    const path = typeof parsed.path === 'string' ? parsed.path : '';
    if (!path) {
      return null;
    }
    const type = typeof parsed.type === 'string' ? parsed.type.toLowerCase() : '';
    let kind: PreviewKind | null = null;
    if (type === 'html' || isHtmlPath(path)) {
      kind = 'html';
    } else if (type === 'markdown' || type === 'md' || isMarkdownPath(path)) {
      kind = 'markdown';
    }
    if (!kind) {
      return null;
    }
    const name = typeof parsed.name === 'string' ? parsed.name : undefined;
    return { path, title: name || getArtifactLabel(path), kind };
  } catch {
    // ignore invalid JSON
  }
  return null;
}

/**
 * Walks newest → oldest completed steps and returns the latest previewable
 * artifact (HTML or markdown) from write/edit tools or ```artifact fences.
 */
export function findLatestHtmlPreviewCandidate(
  steps: TraceStep[],
  cwd?: string | null
): HtmlPreviewCandidate | null {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (step.status !== 'completed') {
      continue;
    }

    if (step.toolName === 'artifact') {
      const fromArtifact = parseArtifactToolOutput(step.toolOutput);
      if (fromArtifact) {
        return {
          path: resolveArtifactPath(fromArtifact.path, cwd),
          title: fromArtifact.title,
          kind: fromArtifact.kind,
          stepId: step.id,
        };
      }
      continue;
    }

    if (!step.toolName || !FILE_TOOL_NAMES.has(step.toolName)) {
      continue;
    }

    const rawPath =
      extractFilePathFromToolOutput(step.toolOutput) ||
      extractFilePathFromToolInput(step.toolInput) ||
      '';
    const kind = previewKindFromPath(rawPath);
    if (!kind) {
      continue;
    }

    const resolved = resolveArtifactPath(rawPath, cwd);
    return {
      path: resolved,
      title: getArtifactLabel(rawPath),
      kind,
      stepId: step.id,
    };
  }

  return null;
}

export function htmlPreviewSignature(candidate: HtmlPreviewCandidate): string {
  return `${candidate.stepId}::${candidate.path}`;
}
