import { describe, expect, it } from 'vitest';
import {
  isCustomWorkingDir,
  isSameWorkingDir,
  workingDirLabel,
} from '../../renderer/utils/working-dir';

describe('working dir helpers', () => {
  it('treats trailing separators as the same folder', () => {
    expect(isSameWorkingDir('/tmp/project/', '/tmp/project')).toBe(true);
    expect(isSameWorkingDir('C:\\work\\app\\', 'C:/work/app')).toBe(true);
  });

  it('marks only a non-default folder as custom', () => {
    expect(isCustomWorkingDir('/Users/me/repo', '/Users/me/Library/default_working_dir')).toBe(
      true
    );
    expect(
      isCustomWorkingDir(
        '/Users/me/Library/default_working_dir/',
        '/Users/me/Library/default_working_dir'
      )
    ).toBe(false);
    expect(isCustomWorkingDir(null, '/tmp/default')).toBe(false);
    expect(isCustomWorkingDir('/tmp/picked', null)).toBe(true);
  });

  it('uses the last path segment as the label', () => {
    expect(workingDirLabel('/Users/me/Documents/York')).toBe('York');
  });
});
