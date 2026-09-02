import { describe, expect, it } from 'vitest';
import {
  divisionFieldsMatchCatalog,
  type DivisionValidationCatalog,
} from '../../shared/workspace-division';
import type { UnifiedCompanyProject } from '../../shared/unified-company-projects';
import {
  validateSessionDivisionAgainstCatalog,
  clearSessionDivisionValidationCache,
} from '../../main/session/validate-session-division';

const catalog: DivisionValidationCatalog = {
  projects: [
    {
      canonicalKey: 'hub:alpha-id',
      name: 'Alpha',
      sources: { hub: true },
      hubProjectId: 'alpha-id',
      hubProjectName: 'Alpha',
      clientName: 'Acme Corp',
    },
    {
      canonicalKey: 'lp:42',
      name: 'Beta LP',
      sources: { launchpad: true },
      launchpadProjectId: 42,
      launchpadProjectName: 'Beta LP',
      clientName: 'Acme Corp',
    },
  ] as UnifiedCompanyProject[],
  folderIds: new Set(['folder-1']),
};

describe('divisionFieldsMatchCatalog', () => {
  it('accepts general and hub without catalog checks', () => {
    expect(divisionFieldsMatchCatalog({ division: 'general' }, catalog).valid).toBe(true);
    expect(divisionFieldsMatchCatalog({ division: 'hub' }, catalog).valid).toBe(true);
  });

  it('accepts allocated project division', () => {
    expect(
      divisionFieldsMatchCatalog(
        {
          division: 'project',
          hubProjectId: 'alpha-id',
          canonicalKey: 'hub:alpha-id',
        },
        catalog
      ).valid
    ).toBe(true);
  });

  it('rejects forged hub project id', () => {
    const result = divisionFieldsMatchCatalog(
      {
        division: 'project',
        hubProjectId: 'not-allocated',
        canonicalKey: 'hub:not-allocated',
      },
      catalog
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('hub project not allocated');
    }
  });

  it('accepts LP-only allocated project', () => {
    expect(
      divisionFieldsMatchCatalog(
        {
          division: 'project',
          launchpadProjectId: 42,
          canonicalKey: 'lp:42',
        },
        catalog
      ).valid
    ).toBe(true);
  });

  it('accepts client division when projects belong to client', () => {
    expect(
      divisionFieldsMatchCatalog(
        {
          division: 'client',
          clientName: 'Acme Corp',
          canonicalKey: 'client:acme-corp',
          clientProjectIds: JSON.stringify([
            { name: 'Alpha', hubProjectId: 'alpha-id', canonicalKey: 'hub:alpha-id' },
          ]),
        },
        catalog
      ).valid
    ).toBe(true);
  });

  it('rejects client project outside client group', () => {
    const result = divisionFieldsMatchCatalog(
      {
        division: 'client',
        clientName: 'Acme Corp',
        canonicalKey: 'client:acme-corp',
        clientProjectIds: JSON.stringify([
          { name: 'Forged', hubProjectId: 'not-allocated', canonicalKey: 'hub:not-allocated' },
        ]),
      },
      catalog
    );
    expect(result.valid).toBe(false);
  });

  it('validates folder ownership', () => {
    expect(
      divisionFieldsMatchCatalog({ division: 'folder', folderId: 'folder-1' }, catalog).valid
    ).toBe(true);
    expect(
      divisionFieldsMatchCatalog({ division: 'folder', folderId: 'folder-x' }, catalog).valid
    ).toBe(false);
  });
});

describe('validateSessionDivisionAgainstCatalog', () => {
  it('demotes invalid project division to general', () => {
    const result = validateSessionDivisionAgainstCatalog(
      { division: 'project', hubProjectId: 'forged-id', canonicalKey: 'hub:forged-id' },
      catalog
    );
    expect(result.demoted).toBe(true);
    expect(result.fields.division).toBe('general');
  });

  it('passes valid project division unchanged', () => {
    const result = validateSessionDivisionAgainstCatalog(
      { division: 'project', hubProjectId: 'alpha-id', canonicalKey: 'hub:alpha-id' },
      catalog
    );
    expect(result.demoted).toBe(false);
    expect(result.fields.division).toBe('project');
    expect(result.fields.hubProjectId).toBe('alpha-id');
  });
});

describe('clearSessionDivisionValidationCache', () => {
  it('does not throw', () => {
    expect(() => clearSessionDivisionValidationCache()).not.toThrow();
  });
});
