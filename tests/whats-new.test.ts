import { describe, expect, it, vi } from 'vitest';
import {
  collectReleaseNotes,
  compareSemver,
  filterUserFacingSections,
  hasUserFacingContent,
  notesUrl,
  normalizeVersion,
  parsePreviousVersion,
} from '../src/main/whats-new/release-notes';
import { getPendingWhatsNew, markWhatsNewSeen } from '../src/main/whats-new/whats-new-service';
import type { WhatsNewStore } from '../src/main/whats-new/whats-new-store';

function memoryStore(initial?: string): WhatsNewStore {
  let lastSeenVersion = initial;
  return {
    getLastSeenVersion: () => lastSeenVersion,
    setLastSeenVersion: (version: string) => {
      lastSeenVersion = version.trim();
    },
  } as unknown as WhatsNewStore;
}

const NOTES_2_11 = `# York GrowthOS v2.11.0

Changes since \`v2.10.0\`.

## Features

- introduce HTML artifact creation and preview functionality
- enforce notarization credentials and enhance pre-build checks

## Other

- bump version to 2.11.0 in package.json and package-lock.json
`;

const NOTES_2_10 = `# York GrowthOS v2.10.0

Changes since \`v2.9.0\`.

## Features

- implement Matter service and related functionality

## Fixes

- update ask disclaimer for clarity in localization file

## Improvements

- streamline Matter button and enhance MatterRadar visuals

## Other

- update version to 2.10.0 in package.json and package-lock.json
`;

const NOTES_2_9 = `# York GrowthOS v2.9.0

Changes since \`v2.8.0\`.

## Features

- implement chat export and import functionality

## Other

- bump version to 2.9.0 in package.json and package-lock.json
`;

describe('normalizeVersion / compareSemver', () => {
  it('strips leading v', () => {
    expect(normalizeVersion('v2.11.0')).toBe('2.11.0');
    expect(normalizeVersion(' 2.10.0 ')).toBe('2.10.0');
  });

  it('orders major.minor.patch', () => {
    expect(compareSemver('2.9.0', '2.10.0')).toBe(-1);
    expect(compareSemver('2.11.0', '2.10.0')).toBe(1);
    expect(compareSemver('2.11.0', '2.11.0')).toBe(0);
    expect(compareSemver('v2.11.0', '2.11.0')).toBe(0);
  });

  it('treats equal numbers differently by prerelease', () => {
    expect(compareSemver('2.11.0-beta', '2.11.0')).toBe(-1);
    expect(compareSemver('2.11.0', '2.11.0-beta')).toBe(1);
  });
});

describe('notesUrl / parsePreviousVersion', () => {
  it('builds the S3 notes URL', () => {
    expect(notesUrl('2.11.0')).toBe(
      'https://york-internal-apps.s3.ap-south-1.amazonaws.com/york-workos/2.11.0/RELEASE_NOTES.md'
    );
  });

  it('parses Changes since baseline', () => {
    expect(parsePreviousVersion(NOTES_2_11)).toBe('2.10.0');
    expect(parsePreviousVersion(NOTES_2_10)).toBe('2.9.0');
    expect(parsePreviousVersion('# no baseline')).toBeNull();
  });
});

describe('filterUserFacingSections', () => {
  it('keeps Features / Fixes / Improvements and drops Other', () => {
    const filtered = filterUserFacingSections(NOTES_2_10);
    expect(filtered).toContain('## Features');
    expect(filtered).toContain('## Fixes');
    expect(filtered).toContain('## Improvements');
    expect(filtered).toContain('implement Matter service');
    expect(filtered).not.toContain('## Other');
    expect(filtered).not.toContain('update version to 2.10.0');
    expect(filtered).not.toContain('Changes since');
    expect(hasUserFacingContent(filtered)).toBe(true);
  });

  it('detects empty user-facing content when only Other remains', () => {
    const onlyOther = `# York GrowthOS v1.0.0

Changes since \`v0.9.0\`.

## Other

- bump version
`;
    const filtered = filterUserFacingSections(onlyOther);
    expect(hasUserFacingContent(filtered)).toBe(false);
  });
});

describe('collectReleaseNotes', () => {
  it('walks newest-first from current back to lastSeen exclusive', async () => {
    const map: Record<string, string> = {
      '2.11.0': NOTES_2_11,
      '2.10.0': NOTES_2_10,
      '2.9.0': NOTES_2_9,
    };
    const fetchText = vi.fn(async (url: string) => {
      const version = url.match(/york-workos\/([^/]+)\/RELEASE_NOTES/)?.[1];
      return version && map[version] ? map[version] : null;
    });

    const result = await collectReleaseNotes({
      fromExclusive: '2.9.0',
      toInclusive: '2.11.0',
      fetchText,
    });

    expect(result).not.toBeNull();
    expect(result!.versions).toEqual(['2.11.0', '2.10.0']);
    expect(result!.markdown).toContain('York GrowthOS v2.11.0');
    expect(result!.markdown).toContain('York GrowthOS v2.10.0');
    expect(result!.markdown).toContain('HTML artifact');
    expect(result!.markdown).toContain('Matter service');
    expect(result!.markdown).not.toContain('chat export');
    expect(result!.markdown).not.toContain('## Other');
    expect(fetchText).toHaveBeenCalledTimes(2);
  });

  it('returns null when first notes fetch fails', async () => {
    const result = await collectReleaseNotes({
      fromExclusive: '2.10.0',
      toInclusive: '2.11.0',
      fetchText: async () => null,
    });
    expect(result).toBeNull();
  });

  it('returns null when all notes lack user-facing sections', async () => {
    const onlyOther = `# York GrowthOS v2.11.0

Changes since \`v2.10.0\`.

## Other

- bump version
`;
    const result = await collectReleaseNotes({
      fromExclusive: '2.10.0',
      toInclusive: '2.11.0',
      fetchText: async () => onlyOther,
    });
    expect(result).toBeNull();
  });
});

describe('getPendingWhatsNew / markWhatsNewSeen', () => {
  it('seeds lastSeen on first run without payload', async () => {
    const store = memoryStore();
    const pending = await getPendingWhatsNew('2.11.0', {
      store,
      fetchText: async () => NOTES_2_11,
    });
    expect(pending).toBeNull();
    expect(store.getLastSeenVersion()).toBe('2.11.0');
  });

  it('returns combined notes after an upgrade', async () => {
    const store = memoryStore('2.9.0');
    const map: Record<string, string> = {
      '2.11.0': NOTES_2_11,
      '2.10.0': NOTES_2_10,
    };
    const pending = await getPendingWhatsNew('2.11.0', {
      store,
      fetchText: async (url) => {
        const version = url.match(/york-workos\/([^/]+)\/RELEASE_NOTES/)?.[1];
        return version && map[version] ? map[version] : null;
      },
    });

    expect(pending).toEqual({
      fromVersion: '2.9.0',
      toVersion: '2.11.0',
      markdown: expect.stringContaining('HTML artifact'),
    });
    // Do not advance lastSeen until dismiss
    expect(store.getLastSeenVersion()).toBe('2.9.0');

    markWhatsNewSeen('2.11.0', { store });
    expect(store.getLastSeenVersion()).toBe('2.11.0');
  });

  it('returns null when already up to date', async () => {
    const store = memoryStore('2.11.0');
    const pending = await getPendingWhatsNew('2.11.0', {
      store,
      fetchText: async () => NOTES_2_11,
    });
    expect(pending).toBeNull();
  });

  it('soft-skips and advances lastSeen when fetch fails', async () => {
    const store = memoryStore('2.10.0');
    const pending = await getPendingWhatsNew('2.11.0', {
      store,
      fetchText: async () => null,
    });
    expect(pending).toBeNull();
    expect(store.getLastSeenVersion()).toBe('2.11.0');
  });

  it('soft-skips when filtered notes are empty', async () => {
    const store = memoryStore('2.10.0');
    const onlyOther = `# York GrowthOS v2.11.0

Changes since \`v2.10.0\`.

## Other

- bump version
`;
    const pending = await getPendingWhatsNew('2.11.0', {
      store,
      fetchText: async () => onlyOther,
    });
    expect(pending).toBeNull();
    expect(store.getLastSeenVersion()).toBe('2.11.0');
  });
});
