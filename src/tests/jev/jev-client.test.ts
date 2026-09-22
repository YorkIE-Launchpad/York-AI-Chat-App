import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { getTypesafeProxyBaseUrl } from '../../shared/backend-config';
import { lexicalRankSkills, lexicalSkillScore } from '../../main/jev/skill-select-jev';

describe('getTypesafeProxyBaseUrl', () => {
  it('points at /typesafe without /v1 suffix', () => {
    expect(getTypesafeProxyBaseUrl('http://127.0.0.1:3001')).toBe(
      'http://127.0.0.1:3001/typesafe'
    );
    expect(getTypesafeProxyBaseUrl('http://127.0.0.1:3001/')).toBe(
      'http://127.0.0.1:3001/typesafe'
    );
  });
});

describe('lexicalSkillScore / lexicalRankSkills', () => {
  const skills = [
    { name: 'york-os', description: 'Company OS router for Hub and Slack' },
    { name: 'pdf', description: 'Create and edit PDF documents' },
    { name: 'docx', description: 'Word document creation' },
  ];

  it('scores exact and substring name matches higher', () => {
    expect(lexicalSkillScore('pdf', skills[1]!)).toBeGreaterThan(
      lexicalSkillScore('pdf', skills[0]!)
    );
  });

  it('ranks matching skills and drops non-matches', () => {
    const ranked = lexicalRankSkills('pdf', skills);
    expect(ranked.map((s) => s.name)).toEqual(['pdf']);
  });

  it('returns all skills unchanged for empty query', () => {
    expect(lexicalRankSkills('', skills)).toHaveLength(3);
  });
});

describe('isJevEnabled via Cognito auth', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false when not authenticated even if jevEnabled', async () => {
    vi.doMock('../../main/config/config-store', () => ({
      configStore: {
        getAll: () => ({ jevEnabled: true }),
      },
    }));
    vi.doMock('../../main/auth/session', () => ({
      isAuthenticated: () => false,
    }));
    const { isJevEnabled, runJevDecision, noul, resetJevClient } = await import(
      '../../main/jev/jev-client'
    );
    resetJevClient();
    expect(isJevEnabled()).toBe(false);
    const result = await runJevDecision('hello', { q: noul('greeting?') });
    expect(result).toBeNull();
  });

  it('returns false when jevEnabled kill-switch is off', async () => {
    vi.doMock('../../main/config/config-store', () => ({
      configStore: {
        getAll: () => ({ jevEnabled: false }),
      },
    }));
    vi.doMock('../../main/auth/session', () => ({
      isAuthenticated: () => true,
    }));
    const { isJevEnabled, resetJevClient } = await import('../../main/jev/jev-client');
    resetJevClient();
    expect(isJevEnabled()).toBe(false);
  });
});

describe('jevRankSkills fallback', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when Jev is disabled so caller uses lexical', async () => {
    vi.doMock('../../main/jev/jev-client', async () => {
      const actual = await vi.importActual<typeof import('../../main/jev/jev-client')>(
        '../../main/jev/jev-client'
      );
      return {
        ...actual,
        isJevEnabled: () => false,
        runJevDecision: vi.fn(async () => null),
      };
    });
    const { jevRankSkills } = await import('../../main/jev/skill-select-jev');
    const ranked = await jevRankSkills({
      query: 'pdf',
      skills: [{ name: 'pdf', description: 'PDF tools' }],
    });
    expect(ranked).toBeNull();
  });
});
