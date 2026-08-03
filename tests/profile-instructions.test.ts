import { describe, expect, it } from 'vitest';
import { buildProfileInstructionsBlock } from '../src/main/agent/profile-instructions';

describe('buildProfileInstructionsBlock', () => {
  it('returns empty string when all prompts are blank', () => {
    expect(
      buildProfileInstructionsBlock({
        profileDosPrompt: '',
        profileDontsPrompt: '   ',
        profileCustomPrompt: '',
      })
    ).toBe('');
  });

  it('includes only non-empty sections', () => {
    const block = buildProfileInstructionsBlock({
      profileDosPrompt: 'Be concise',
      profileDontsPrompt: '',
      profileCustomPrompt: 'Timezone IST',
    });

    expect(block).toContain('## USER PROFILE MUST INSTRUCTIONS');
    expect(block).toContain('### Dos');
    expect(block).toContain('Be concise');
    expect(block).toContain('### Custom');
    expect(block).toContain('Timezone IST');
    expect(block).not.toContain("### Don'ts");
  });
});
