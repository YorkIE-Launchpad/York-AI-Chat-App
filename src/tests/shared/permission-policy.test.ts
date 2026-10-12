import { describe, expect, it } from 'vitest';
import {
  applyPermissionEdits,
  PERMISSION_ASK_TIMEOUT_MS,
  PERMISSION_AUTO_APPROVE_MS,
  truncatePermissionInputPreview,
} from '../../shared/permission-policy';

describe('permission-policy', () => {
  it('uses a 5-minute ask timeout', () => {
    expect(PERMISSION_ASK_TIMEOUT_MS).toBe(5 * 60 * 1000);
  });

  it('auto-approves local asks after 60 seconds', () => {
    expect(PERMISSION_AUTO_APPROVE_MS).toBe(60 * 1000);
  });

  it('keeps path fields and truncates large write content', () => {
    const content = 'x'.repeat(5000);
    const preview = truncatePermissionInputPreview({
      path: 'outputs/bench-report.html',
      content,
    });

    expect(preview.path).toBe('outputs/bench-report.html');
    expect(typeof preview.content).toBe('string');
    expect(String(preview.content).length).toBeLessThan(content.length);
    expect(preview.content_truncated).toBe(true);
    expect(preview.content_length).toBe(5000);
  });

  it('does not truncate short payloads', () => {
    const preview = truncatePermissionInputPreview({
      path: 'a.txt',
      content: 'hello',
    });
    expect(preview).toEqual({ path: 'a.txt', content: 'hello' });
  });

  it('applies edited draft strings in place without adding keys or changing types', () => {
    const input: Record<string, unknown> = {
      channel: 'C123',
      text: 'Original draft',
      count: 2,
      fields: { summary: 'Old', priority: 'High' },
    };
    applyPermissionEdits(input, {
      text: 'Edited draft',
      count: '3',
      injected: 'nope',
      fields: { summary: 'New', extra: 'nope' },
    });
    expect(input).toEqual({
      channel: 'C123',
      text: 'Edited draft',
      count: 2,
      fields: { summary: 'New', priority: 'High' },
    });
  });
});
