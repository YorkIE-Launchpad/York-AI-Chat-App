import type { TipDefinition } from './types';
import { snapWiggleTip } from './snap-wiggle';
import { askAnywhereTip } from './ask-anywhere';
import { snapShortcutTip } from './snap-shortcut';
import { commandPaletteTip } from './command-palette';
import { keyboardShortcutsTip } from './keyboard-shortcuts';
import { slashSkillsTip } from './slash-skills';
import { privateChatTip } from './private-chat';
import { thinkingModeTip } from './thinking-mode';
import { dictationTip } from './dictation';
import { imageModeTip } from './image-mode';
import { htmlPreviewTip } from './html-preview';
import { yorkLlmTip } from './york-llm';
import { todayBriefingTip } from './today-briefing';
import { askMatterTip } from './ask-matter';
import { opportunitiesTip } from './opportunities';
import { followUpsTip } from './follow-ups';
import { meetingsTip } from './meetings';
import { automationsTip } from './automations';
import { memoryTip } from './memory';

/** All tips, in first-launch order (Settings → Tips groups them by category). Add new tips here. */
export const TIPS: TipDefinition[] = [
  snapWiggleTip,
  askAnywhereTip,
  snapShortcutTip,
  commandPaletteTip,
  keyboardShortcutsTip,
  slashSkillsTip,
  privateChatTip,
  thinkingModeTip,
  dictationTip,
  imageModeTip,
  htmlPreviewTip,
  yorkLlmTip,
  todayBriefingTip,
  askMatterTip,
  opportunitiesTip,
  followUpsTip,
  meetingsTip,
  automationsTip,
  memoryTip,
];
