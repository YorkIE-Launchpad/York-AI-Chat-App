/**
 * Pure helpers for fetching and combining S3 RELEASE_NOTES.md files.
 * each file is a delta since the previous published tag and embeds:
 *   Changes since `vX.Y.Z`.
 */

export const RELEASE_NOTES_BASE_URL =
  'https://york-internal-apps.s3.ap-south-1.amazonaws.com/york-workos';

const USER_FACING_SECTIONS = new Set(['Features', 'Fixes', 'Improvements']);
export const DEFAULT_MAX_NOTES_DEPTH = 20;

const PREVIOUS_VERSION_RE = /Changes since\s+`?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)`?/i;
const H2_RE = /^##\s+(.+)$/;

/** Strip a leading `v` and whitespace. Returns empty string if invalid. */
export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '');
}

/**
 * Compare two semver-like strings (major.minor.patch[-prerelease]).
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 * Non-numeric tail is compared lexicographically after the numeric parts.
 */
export function compareSemver(a: string, b: string): number {
  const na = normalizeVersion(a);
  const nb = normalizeVersion(b);
  if (!na || !nb) return 0;

  const [aCore, aPre = ''] = na.split('-', 2);
  const [bCore, bPre = ''] = nb.split('-', 2);

  const aParts = aCore.split('.').map((p) => parseInt(p, 10) || 0);
  const bParts = bCore.split('.').map((p) => parseInt(p, 10) || 0);
  const len = Math.max(aParts.length, bParts.length, 3);

  for (let i = 0; i < len; i++) {
    const av = aParts[i] ?? 0;
    const bv = bParts[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }

  // Release (no pre) sorts after prerelease of same core
  if (aPre && !bPre) return -1;
  if (!aPre && bPre) return 1;
  if (aPre < bPre) return -1;
  if (aPre > bPre) return 1;
  return 0;
}

export function notesUrl(version: string): string {
  const v = normalizeVersion(version);
  return `${RELEASE_NOTES_BASE_URL}/${encodeURIComponent(v)}/RELEASE_NOTES.md`;
}

/** Parse previous baseline version from a notes file, or null. */
export function parsePreviousVersion(markdown: string): string | null {
  const match = markdown.match(PREVIOUS_VERSION_RE);
  if (!match?.[1]) return null;
  return normalizeVersion(match[1]);
}

/**
 * Keep Features / Fixes / Improvements only; drop Other and the
 * "Changes since" metadata line used for chain walking.
 */
export function filterUserFacingSections(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const out: string[] = [];
  let currentSection: string | null = null;
  let keepSection = true;

  for (const line of lines) {
    const h2 = line.match(H2_RE);
    if (h2) {
      currentSection = h2[1].trim();
      keepSection = USER_FACING_SECTIONS.has(currentSection);
      if (keepSection) {
        out.push(line);
      }
      continue;
    }

    const trimmed = line.trim();
    if (/^Changes since\b/i.test(trimmed) || /^Initial release\.?$/i.test(trimmed)) {
      continue;
    }

    if (currentSection === null || keepSection) {
      out.push(line);
    }
  }

  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function hasUserFacingContent(filteredMarkdown: string): boolean {
  return /^##\s+(Features|Fixes|Improvements)\b/m.test(filteredMarkdown);
}

export type FetchReleaseNotesText = (url: string) => Promise<string | null>;

export interface CollectReleaseNotesResult {
  versions: string[];
  markdown: string;
}

/**
 * Walk RELEASE_NOTES chain from `toInclusive` backwards while previous > fromExclusive.
 * Newest-first combine. Stops on missing file or max depth.
 */
export async function collectReleaseNotes(opts: {
  fromExclusive: string;
  toInclusive: string;
  fetchText: FetchReleaseNotesText;
  maxDepth?: number;
}): Promise<CollectReleaseNotesResult | null> {
  const from = normalizeVersion(opts.fromExclusive);
  let version = normalizeVersion(opts.toInclusive);
  if (!from || !version) return null;
  if (compareSemver(from, version) >= 0) return null;

  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_NOTES_DEPTH;
  const parts: string[] = [];
  const versions: string[] = [];

  for (let depth = 0; depth < maxDepth; depth++) {
    const text = await opts.fetchText(notesUrl(version));
    if (!text) {
      // Break the chain; keep anything already collected
      break;
    }

    const filtered = filterUserFacingSections(text);
    if (hasUserFacingContent(filtered)) {
      parts.push(filtered);
      versions.push(version);
    }

    const prev = parsePreviousVersion(text);
    if (!prev) break;
    if (compareSemver(prev, from) <= 0) break;
    version = prev;
  }

  if (parts.length === 0) return null;
  return {
    versions,
    markdown: parts.join('\n\n'),
  };
}
