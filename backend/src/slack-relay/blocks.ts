/**
 * Block Kit renderers for the Slack relay. Every string that came from the
 * desktop is escaped before it lands in mrkdwn; plain_text fields render
 * literally and are only length-capped.
 */
import type { SlackBlock } from './slack-api.js';
import { SLASH_COMMAND, type PickerKind } from './protocol.js';
import { escapeSlackText } from './sanitize.js';

export const ACTION_IDS = {
  approvalAllow: 'growth_approval_allow',
  approvalDeny: 'growth_approval_deny',
  chatOpen: 'growth_chat_open',
  chatNew: 'growth_chat_new',
  questionOption: 'growth_q_option',
  questionSubmit: 'growth_q_submit',
  questionSkip: 'growth_q_skip',
  pick: 'growth_pick',
} as const;

export interface QuestionOption {
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface QuestionItem {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

export type QuestionCardState = 'pending' | 'submitting' | 'answered' | 'skipped' | 'expired';

/** One tap answers a lone single-choice question; anything else needs Submit. */
export function questionNeedsSubmit(questions: QuestionItem[]): boolean {
  return !(questions.length === 1 && !questions[0].multiSelect && questions[0].options.length > 0);
}

/** Button value for an option: `<questionId>.<question>.<option>`. */
export function questionOptionValue(questionId: string, q: number, o: number): string {
  return `${questionId}.${q}.${o}`;
}

export function parseQuestionOptionValue(
  value: string
): { questionId: string; q: number; o: number } | null {
  const match = /^([A-Za-z0-9_-]{16,64})\.(\d)\.(\d)$/.exec(value);
  if (!match) return null;
  return { questionId: match[1], q: Number(match[2]), o: Number(match[3]) };
}

export type ApprovalCardState =
  | 'pending'
  | 'allowing'
  | 'denying'
  | 'allowed'
  | 'denied'
  | 'expired';

export interface RenderedMessage {
  text: string;
  blocks: SlackBlock[];
}

/** Section text is capped by Slack at 3000 chars. */
export const BLOCK_TEXT_MAX = 2_900;

function mrkdwn(text: string): { type: 'mrkdwn'; text: string } {
  return { type: 'mrkdwn', text };
}

function plain(text: string, max = 75): { type: 'plain_text'; text: string; emoji: boolean } {
  return {
    type: 'plain_text',
    text: text.length > max ? `${text.slice(0, max - 1)}…` : text,
    emoji: true,
  };
}

function context(text: string): SlackBlock {
  return { type: 'context', elements: [mrkdwn(text)] };
}

function section(text: string): SlackBlock {
  return { type: 'section', text: mrkdwn(text) };
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

export function renderWorkingStatus(label: string): RenderedMessage {
  const safe = escapeSlackText(label);
  return {
    text: `Working on it… ${safe}`,
    blocks: [context(`:hourglass_flowing_sand: *Working on it…*  ·  ${safe}`)],
  };
}

export function renderFinishedStatus(input: {
  outcome: 'done' | 'error';
  elapsedMs: number;
  steps: number;
}): RenderedMessage {
  const elapsed = formatElapsed(input.elapsedMs);
  if (input.outcome === 'error') {
    return {
      text: `Stopped after ${elapsed}`,
      blocks: [
        context(
          `:x: Something went wrong after ${elapsed}. Check York IE GrowthOS on your computer.`
        ),
      ],
    };
  }
  const steps = input.steps === 1 ? '1 step' : `${input.steps} steps`;
  const summary = input.steps > 0 ? `Done in ${elapsed}  ·  ${steps}` : `Done in ${elapsed}`;
  return { text: summary, blocks: [context(`:white_check_mark: ${summary}`)] };
}

function fence(detail: string): string {
  return `\`\`\`${escapeSlackText(detail.replace(/```/g, "'''"))}\`\`\``;
}

export function renderApprovalCard(input: {
  approvalId: string;
  toolName: string;
  summary: string;
  detail?: string;
  state: ApprovalCardState;
  expiresInSec: number;
}): RenderedMessage {
  const tool = escapeSlackText(input.toolName);
  const blocks: SlackBlock[] = [
    section(
      `:raised_hand: *York IE GrowthOS wants to run \`${tool}\`*\n${escapeSlackText(input.summary)}`
    ),
  ];
  if (input.detail) blocks.push(section(fence(input.detail)));

  switch (input.state) {
    case 'pending':
      blocks.push({
        type: 'actions',
        block_id: 'growth_approval',
        elements: [
          {
            type: 'button',
            action_id: ACTION_IDS.approvalAllow,
            text: plain('Allow'),
            style: 'primary',
            value: input.approvalId,
          },
          {
            type: 'button',
            action_id: ACTION_IDS.approvalDeny,
            text: plain('Deny'),
            style: 'danger',
            value: input.approvalId,
          },
        ],
      });
      blocks.push(
        context(
          `Denied automatically if there's no answer within ${formatElapsed(input.expiresInSec * 1000)}. You can also reply "yes" or "no".`
        )
      );
      break;
    case 'allowing':
      blocks.push(context(':hourglass_flowing_sand: Allowing…'));
      break;
    case 'denying':
      blocks.push(context(':hourglass_flowing_sand: Denying…'));
      break;
    case 'allowed':
      blocks.push(context(':white_check_mark: Allowed'));
      break;
    case 'denied':
      blocks.push(context(':no_entry_sign: Denied'));
      break;
    case 'expired':
      blocks.push(context(':alarm_clock: Expired (denied automatically)'));
      break;
  }
  return {
    text: escapeSlackText(`York IE GrowthOS wants to run ${input.toolName}: ${input.summary}`),
    blocks,
  };
}

function questionTitle(item: QuestionItem, index: number, total: number): string {
  const prefix = total > 1 ? `Q${index + 1}` : '';
  const header = item.header ? escapeSlackText(item.header) : '';
  const label = [prefix, header].filter(Boolean).join(' · ');
  const question = escapeSlackText(item.question);
  return label ? `*${label}*\n${question}` : `*${question}*`;
}

export function renderQuestionCard(input: {
  questionId: string;
  questions: QuestionItem[];
  selections: number[][];
  state: QuestionCardState;
  expiresInSec: number;
  /** Final answers as labels, when known (typed replies are parsed by the desktop). */
  answers?: string[][];
}): RenderedMessage {
  const { questionId, questions, selections, state } = input;
  const interactive = state === 'pending';
  const total = questions.length;
  const blocks: SlackBlock[] = [
    section(
      total > 1
        ? `:speech_balloon: *York IE GrowthOS has ${total} questions for you*`
        : ':speech_balloon: *York IE GrowthOS has a question for you*'
    ),
  ];

  questions.forEach((item, q) => {
    blocks.push({ type: 'divider' });
    if (!interactive) {
      const picked =
        input.answers?.[q] ?? selections[q]?.map((o) => item.options[o]?.label).filter(Boolean);
      const answer =
        picked && picked.length > 0
          ? `:white_check_mark: ${escapeSlackText(picked.join(', '))}`
          : '_No answer_';
      blocks.push(section(`${questionTitle(item, q, total)}\n${answer}`));
      return;
    }

    blocks.push(section(questionTitle(item, q, total)));
    if (item.options.length === 0) {
      blocks.push(context(':pencil2: Reply in this chat with your answer.'));
      return;
    }
    item.options.forEach((option, o) => {
      const selected = selections[q]?.includes(o) ?? false;
      const letter = String.fromCharCode(65 + o);
      const recommended = option.recommended ? '  ·  _Recommended_' : '';
      const description = option.description ? `\n${escapeSlackText(option.description)}` : '';
      blocks.push({
        type: 'section',
        text: mrkdwn(`*${letter}. ${escapeSlackText(option.label)}*${recommended}${description}`),
        accessory: {
          type: 'button',
          action_id: ACTION_IDS.questionOption,
          text: plain(selected ? '✓ Selected' : 'Choose'),
          ...(selected ? { style: 'primary' } : {}),
          value: questionOptionValue(questionId, q, o),
        },
      });
    });
    if (item.multiSelect) blocks.push(context('Choose one or more.'));
  });

  blocks.push({ type: 'divider' });
  if (interactive) {
    const buttons: SlackBlock[] = [];
    if (questionNeedsSubmit(questions)) {
      buttons.push({
        type: 'button',
        action_id: ACTION_IDS.questionSubmit,
        text: plain('Submit'),
        style: 'primary',
        value: questionId,
      });
    }
    buttons.push({
      type: 'button',
      action_id: ACTION_IDS.questionSkip,
      text: plain('Skip'),
      value: questionId,
    });
    blocks.push({ type: 'actions', block_id: 'growth_question_actions', elements: buttons });
    const example = total > 1 ? '`Q1: A`' : '`A`';
    blocks.push(
      context(
        `Expires in ${formatElapsed(input.expiresInSec * 1000)}. You can also reply with text, e.g. ${example}.`
      )
    );
  } else {
    const footer: Record<Exclude<QuestionCardState, 'pending'>, string> = {
      submitting: ':hourglass_flowing_sand: Sending your answer…',
      answered: ':white_check_mark: Answered',
      skipped: ':fast_forward: Skipped',
      expired: ':alarm_clock: Expired',
    };
    blocks.push(context(footer[state]));
  }

  const summary = questions.map((item) => item.question).join(' / ');
  return {
    text: escapeSlackText(`York IE GrowthOS has a question: ${summary}`.slice(0, 2_000)),
    blocks,
  };
}

export function renderChatList(
  chats: Array<{ token: string; title: string; updatedLabel: string; current: boolean }>
): RenderedMessage {
  const blocks: SlackBlock[] = [section('*Your recent York IE GrowthOS chats*')];
  if (chats.length === 0) {
    blocks.push(context('No chats yet. Send a message to start one.'));
  }
  for (const chat of chats) {
    const title = escapeSlackText(chat.title);
    const meta = escapeSlackText(chat.updatedLabel);
    if (chat.current) {
      blocks.push(section(`*${title}*\n:large_green_circle: Current chat  ·  ${meta}`));
    } else {
      blocks.push({
        type: 'section',
        text: mrkdwn(`*${title}*\n${meta}`),
        accessory: {
          type: 'button',
          action_id: ACTION_IDS.chatOpen,
          text: plain('Open'),
          value: chat.token,
        },
      });
    }
  }
  blocks.push({
    type: 'actions',
    block_id: 'growth_chat_actions',
    elements: [
      {
        type: 'button',
        action_id: ACTION_IDS.chatNew,
        text: plain('New chat'),
        style: 'primary',
        value: 'new',
      },
    ],
  });
  return { text: 'Your recent York IE GrowthOS chats', blocks };
}

export interface PickerItem {
  token: string;
  label: string;
  detail: string;
  current: boolean;
}

const PICKER_HEADINGS: Record<PickerKind, string> = {
  model: ':brain: *Choose a model*',
  workspace: ':file_folder: *Choose a workspace*',
};

const PICKER_EMPTY: Record<PickerKind, string> = {
  model: 'No models are available right now.',
  workspace: 'No workspaces matched.',
};

/** Model or workspace list with a "Use" button per entry. */
export function renderPicker(input: {
  kind: PickerKind;
  items: PickerItem[];
  note?: string;
}): RenderedMessage {
  const blocks: SlackBlock[] = [section(PICKER_HEADINGS[input.kind])];
  if (input.items.length === 0) blocks.push(context(PICKER_EMPTY[input.kind]));
  for (const item of input.items) {
    const label = escapeSlackText(item.label);
    const detail = item.detail ? `\n${escapeSlackText(item.detail)}` : '';
    if (item.current) {
      blocks.push(section(`*${label}*  :large_green_circle: Current${detail}`));
    } else {
      blocks.push({
        type: 'section',
        text: mrkdwn(`*${label}*${detail}`),
        accessory: {
          type: 'button',
          action_id: ACTION_IDS.pick,
          text: plain('Use'),
          value: item.token,
        },
      });
    }
  }
  if (input.note) blocks.push(context(escapeSlackText(input.note)));
  return {
    text: input.kind === 'model' ? 'Choose a model' : 'Choose a workspace',
    blocks,
  };
}

export function helpText(command: string = SLASH_COMMAND): string {
  const c = /^\/[a-z0-9_-]{1,31}$/i.test(command) ? command : SLASH_COMMAND;
  return [
    '*Control York IE GrowthOS from Slack*',
    'Just send a message to work in your current chat. Or use:',
    `• \`${c} new\` (or \`${c} new <message>\`) – start a fresh chat`,
    `• \`${c} chats\` – pick one of your recent chats`,
    `• \`${c} model\` (or \`${c} model <name>\`) – see or change the model`,
    `• \`${c} workspace\` (or \`${c} workspace <name>\`) – see or change the workspace`,
    `• \`${c} stop\` – stop what York IE GrowthOS is doing`,
    `• \`${c} status\` – show the current chat and whether it's busy`,
    `• \`${c} help\` – show this help`,
    'You can also just send `help` in this DM.',
  ].join('\n');
}

/** Final answer chunk plus a small footer line. */
export function renderReplyWithFooter(chunk: string, footer: string): RenderedMessage {
  return {
    text: chunk,
    blocks: [section(chunk), context(escapeSlackText(footer))],
  };
}
