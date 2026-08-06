import { describe, expect, it } from 'vitest';
import { isHubSkillInstalled, normalizeSkillIdentity } from '../../shared/hub-skill-install-state';

describe('hub skill install state', () => {
  it('normalizes titles and slugs for comparison', () => {
    expect(normalizeSkillIdentity('York OS')).toBe('yorkos');
    expect(normalizeSkillIdentity('york-os')).toBe('yorkos');
    expect(normalizeSkillIdentity('  PDF Maker  ')).toBe('pdfmaker');
  });

  it('matches when SKILL.md name is a slug form of the Hub title', () => {
    expect(
      isHubSkillInstalled({ id: 'hub-1', title: 'PDF Maker', slug: 'pdf-maker' }, [
        { id: 'global-pdf-maker', name: 'pdf-maker' },
      ])
    ).toBe(true);
  });

  it('does not require exact title === name', () => {
    // Exact-string matching was the old bug: first skill worked when names
    // matched; later ones with "Pretty Title" vs slug name still showed Install.
    expect(
      isHubSkillInstalled({ id: 'hub-2', title: 'Quarterly Business Review', slug: 'qbr' }, [
        { id: 'global-qbr', name: 'qbr' },
      ])
    ).toBe(true);
  });

  it('matches by persisted Hub skill id even when names totally differ', () => {
    expect(
      isHubSkillInstalled({ id: 'uuid-abc', title: 'Human Friendly Title' }, [
        { name: 'weird-pack-name', hubSkillId: 'uuid-abc' },
      ])
    ).toBe(true);
    expect(
      isHubSkillInstalled({ id: 'uuid-abc', title: 'Human Friendly Title' }, [
        { name: 'weird-pack-name', config: { hubSkillId: 'uuid-abc' } },
      ])
    ).toBe(true);
  });

  it('honors optimistic installed hub id set during install', () => {
    expect(
      isHubSkillInstalled(
        { id: 'uuid-new', title: 'Anything' },
        [{ name: 'unrelated' }],
        ['uuid-new']
      )
    ).toBe(true);
  });

  it('returns false when there is no identity overlap', () => {
    expect(
      isHubSkillInstalled({ id: 'hub-x', title: 'Alpha', slug: 'alpha' }, [{ name: 'beta' }])
    ).toBe(false);
  });
});
