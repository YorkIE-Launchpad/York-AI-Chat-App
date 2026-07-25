import { describe, expect, it, beforeEach } from 'vitest';
import { decode } from '@toon-format/toon';
import {
  MCP_DEFAULT_LIST_LIMIT,
  MCP_TOOL_RESULT_MAX_CHARS,
  augmentMcpToolDescription,
  clearMcpToolResultSpilloverCache,
  compressToolResultTextForModel,
  getMcpToolResultSpillover,
  leanMcpToolArgs,
  pruneEmptyValues,
} from '../src/main/agent/mcp-tool-payload';

describe('leanMcpToolArgs', () => {
  it('drops empty optional values but keeps required empties', () => {
    const lean = leanMcpToolArgs(
      {
        query: '',
        filters: [],
        meta: {},
        emptyRequired: '',
        keep: 'x',
      },
      {
        properties: {
          query: { type: 'string' },
          filters: { type: 'array' },
          meta: { type: 'object' },
          emptyRequired: { type: 'string' },
          keep: { type: 'string' },
        },
        required: ['emptyRequired'],
      }
    );

    expect(lean).toEqual({ emptyRequired: '', keep: 'x' });
  });

  it('injects limit default only when schema exposes limit and model omitted it', () => {
    const withLimit = leanMcpToolArgs(
      { projectId: 'p1' },
      {
        properties: {
          projectId: { type: 'string' },
          limit: { type: 'number' },
        },
      }
    );
    expect(withLimit).toEqual({ projectId: 'p1', limit: MCP_DEFAULT_LIST_LIMIT });

    const withoutLimitProp = leanMcpToolArgs(
      { projectId: 'p1' },
      { properties: { projectId: { type: 'string' } } }
    );
    expect(withoutLimitProp).toEqual({ projectId: 'p1' });

    const explicitLimit = leanMcpToolArgs(
      { limit: 5 },
      { properties: { limit: { type: 'number' } } }
    );
    expect(explicitLimit).toEqual({ limit: 5 });
  });

  it('injects pageSize when that property name is used', () => {
    const lean = leanMcpToolArgs({}, { properties: { pageSize: { type: 'number' } } });
    expect(lean).toEqual({ pageSize: MCP_DEFAULT_LIST_LIMIT });
  });
});

describe('augmentMcpToolDescription', () => {
  it('nudges list/analytics/summary tools', () => {
    const desc = augmentMcpToolDescription(
      'mcp__York_IE_HUB__get_employee_overview_analytics',
      'Returns employee overview analytics.'
    );
    expect(desc).toContain('Avoid unbounded org-wide dumps');
    expect(desc).toContain('Returns employee overview analytics.');
  });

  it('does not nudge unrelated tools', () => {
    const desc = augmentMcpToolDescription('mcp__York_IE_HUB__get_me', 'Current user profile.');
    expect(desc).toBe('Current user profile.');
  });

  it('is idempotent', () => {
    const once = augmentMcpToolDescription('list_projects', 'List projects.');
    const twice = augmentMcpToolDescription('list_projects', once);
    expect(twice).toBe(once);
  });
});

describe('pruneEmptyValues', () => {
  it('keeps 0 and false, drops null/empty', () => {
    expect(
      pruneEmptyValues({
        a: 0,
        b: false,
        c: null,
        d: '',
        e: [],
        f: {},
        g: { nested: null, keep: 1 },
        h: [null, 2, ''],
      })
    ).toEqual({
      a: 0,
      b: false,
      g: { keep: 1 },
      h: [2],
    });
  });
});

describe('compressToolResultTextForModel', () => {
  beforeEach(() => {
    clearMcpToolResultSpilloverCache();
  });

  it('leaves non-JSON text unchanged', () => {
    expect(compressToolResultTextForModel('hello world')).toBe('hello world');
  });

  it('encodes JSON arrays as TOON (lossless after prune)', () => {
    const rows = [
      { id: 1, name: 'alpha', unused: null },
      { id: 2, name: 'beta', unused: '' },
    ];
    const out = compressToolResultTextForModel(JSON.stringify(rows));
    expect(out.startsWith('format: toon\n')).toBe(true);
    const body = out.slice('format: toon\n'.length);
    expect(decode(body)).toEqual([
      { id: 1, name: 'alpha' },
      { id: 2, name: 'beta' },
    ]);
  });

  it('pages oversized results with inventory and caches full payload', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({
      id: i,
      name: `employee-${i}`,
      email: `e${i}@example.com`,
      project: `project-${i % 50}`,
      hours: i % 40,
      notes: 'x'.repeat(40),
    }));
    const raw = JSON.stringify(rows);
    expect(raw.length).toBeGreaterThan(MCP_TOOL_RESULT_MAX_CHARS);

    const out = compressToolResultTextForModel(raw, {
      maxChars: 5_000,
      pageTargetChars: 4_000,
    });

    expect(out).toContain('format: toon');
    expect(out).toContain('paged: true');
    expect(out).toContain('cacheId:');
    expect(out).toContain('totalItems: 5000');
    expect(out).toContain('Re-call the same tool');
    expect(out.length).toBeLessThanOrEqual(5_000);

    const cacheIdMatch = out.match(/cacheId: ([a-f0-9]+)/);
    expect(cacheIdMatch).toBeTruthy();
    const cached = getMcpToolResultSpillover(cacheIdMatch![1]);
    expect(Array.isArray(cached)).toBe(true);
    expect((cached as unknown[]).length).toBe(5000);
  });
});
