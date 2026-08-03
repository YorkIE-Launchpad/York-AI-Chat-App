import type { AppConfig } from '../config/config-store';

export type ProfileInstructionFields = Pick<
  AppConfig,
  'profileDosPrompt' | 'profileDontsPrompt' | 'profileCustomPrompt'
>;

/**
 * Build a MUST instruction block from user profile prompts.
 * Returns '' when all three fields are blank/whitespace.
 */
export function buildProfileInstructionsBlock(config: ProfileInstructionFields): string {
  const dos = config.profileDosPrompt?.trim() || '';
  const donts = config.profileDontsPrompt?.trim() || '';
  const custom = config.profileCustomPrompt?.trim() || '';

  if (!dos && !donts && !custom) {
    return '';
  }

  const parts = [
    '## USER PROFILE MUST INSTRUCTIONS',
    'These are mandatory user profile rules. Follow them in every response and action unless they conflict with safety or hard system rules.',
  ];

  if (dos) {
    parts.push('', '### Dos', dos);
  }
  if (donts) {
    parts.push('', "### Don'ts", donts);
  }
  if (custom) {
    parts.push('', '### Custom', custom);
  }

  return parts.join('\n');
}
