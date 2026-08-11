import { describe, it, expect } from 'vitest';
import type { TraceStep } from '../src/renderer/types';
import {
  findLatestHtmlPreviewCandidate,
  htmlPreviewSignature,
  isHtmlPath,
} from '../src/renderer/utils/html-preview';

describe('isHtmlPath', () => {
  it('detects html and htm extensions', () => {
    expect(isHtmlPath('outputs/deck.html')).toBe(true);
    expect(isHtmlPath('C:\\tmp\\page.HTM')).toBe(true);
    expect(isHtmlPath('outputs/deck.pptx')).toBe(false);
    expect(isHtmlPath('')).toBe(false);
  });
});

describe('findLatestHtmlPreviewCandidate', () => {
  it('returns the newest completed HTML write', () => {
    const steps: TraceStep[] = [
      {
        id: 'w1',
        type: 'tool_call',
        status: 'completed',
        title: 'Write',
        toolName: 'Write',
        toolInput: { path: 'outputs/a.html', content: '<html></html>' },
        toolOutput: 'File written: outputs/a.html',
        timestamp: 1,
      },
      {
        id: 'w2',
        type: 'tool_call',
        status: 'completed',
        title: 'Write',
        toolName: 'Write',
        toolInput: { path: 'outputs/b.html', content: '<html></html>' },
        toolOutput: 'File written: outputs/b.html',
        timestamp: 2,
      },
    ];

    const candidate = findLatestHtmlPreviewCandidate(steps, '/workspace');
    expect(candidate?.stepId).toBe('w2');
    expect(candidate?.path).toContain('b.html');
    expect(htmlPreviewSignature(candidate!)).toContain('w2');
  });

  it('accepts artifact fences with type html', () => {
    const steps: TraceStep[] = [
      {
        id: 'art1',
        type: 'tool_result',
        status: 'completed',
        title: 'artifact',
        toolName: 'artifact',
        toolOutput: JSON.stringify({
          path: 'outputs/client-update.html',
          name: 'Client update',
          type: 'html',
        }),
        timestamp: 1,
      },
    ];

    const candidate = findLatestHtmlPreviewCandidate(steps, '/workspace');
    expect(candidate?.title).toBe('Client update');
    expect(candidate?.path).toContain('client-update.html');
  });

  it('ignores non-html writes', () => {
    const steps: TraceStep[] = [
      {
        id: 'w1',
        type: 'tool_call',
        status: 'completed',
        title: 'Write',
        toolName: 'Write',
        toolInput: { path: 'outputs/notes.md', content: 'hi' },
        toolOutput: 'File written: outputs/notes.md',
        timestamp: 1,
      },
    ];

    expect(findLatestHtmlPreviewCandidate(steps, '/workspace')).toBeNull();
  });

  it('remaps outside absolute outputs/ artifact paths into the session cwd', () => {
    const steps: TraceStep[] = [
      {
        id: 'art1',
        type: 'tool_result',
        status: 'completed',
        title: 'artifact',
        toolName: 'artifact',
        toolOutput: JSON.stringify({
          path: '/Users/lay.s/outputs/sports-data-provider-executive/report.html',
          name: 'Sports Data Provider Evaluation 2026 Client Report',
          type: 'html',
        }),
        timestamp: 1,
      },
    ];

    const candidate = findLatestHtmlPreviewCandidate(steps, '/Users/demo/project');
    expect(candidate?.path).toBe(
      '/Users/demo/project/outputs/sports-data-provider-executive/report.html'
    );
    expect(candidate?.title).toBe('Sports Data Provider Evaluation 2026 Client Report');
  });
});
