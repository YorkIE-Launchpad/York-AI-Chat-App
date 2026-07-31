import { describe, expect, it } from 'vitest';
import { normalizeWorkspaceKey } from '../../main/memory/memory-utils';
import { divisionMemoryKey } from '../../shared/workspace-division';

describe('normalizeWorkspaceKey with division keys', () => {
  it('passes through vecos:// division keys', () => {
    expect(normalizeWorkspaceKey('vecos://general')).toBe('vecos://general');
    expect(normalizeWorkspaceKey('vecos://hub')).toBe('vecos://hub');
    expect(normalizeWorkspaceKey('vecos://project/abc')).toBe('vecos://project/abc');
  });

  it('still resolves filesystem paths', () => {
    const key = normalizeWorkspaceKey('/tmp/workspace');
    expect(key).toContain('workspace');
    expect(key?.startsWith('vecos://')).toBe(false);
  });

  it('aligns with divisionMemoryKey output', () => {
    const memoryKey = divisionMemoryKey({
      division: 'project',
      hubProjectId: 'hub-42',
      hubProjectName: 'Demo',
    });
    expect(normalizeWorkspaceKey(memoryKey)).toBe(memoryKey);
  });
});
