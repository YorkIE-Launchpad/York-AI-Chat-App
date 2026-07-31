import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseSemver, nextVersion } = require('../scripts/bump-version.js') as {
  parseSemver: (version: string) => { major: number; minor: number; patch: number };
  nextVersion: (current: string, target: string) => string;
};

describe('bump-version', () => {
  it('parses semver', () => {
    expect(parseSemver('2.2.0')).toEqual({ major: 2, minor: 2, patch: 0 });
  });

  it('rejects invalid semver', () => {
    expect(() => parseSemver('2.2')).toThrow(/Invalid semver/);
    expect(() => parseSemver('v2.2.0')).toThrow(/Invalid semver/);
  });

  it('bumps patch/minor/major', () => {
    expect(nextVersion('2.2.0', 'patch')).toBe('2.2.1');
    expect(nextVersion('2.2.1', 'minor')).toBe('2.3.0');
    expect(nextVersion('2.3.5', 'major')).toBe('3.0.0');
  });

  it('sets an explicit version', () => {
    expect(nextVersion('2.2.0', '2.4.0')).toBe('2.4.0');
  });

  it('rejects setting the same version', () => {
    expect(() => nextVersion('2.2.0', '2.2.0')).toThrow(/already 2\.2\.0/);
  });
});
