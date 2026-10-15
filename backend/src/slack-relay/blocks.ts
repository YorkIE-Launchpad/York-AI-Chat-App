/**
 * Block Kit renderers for the Slack relay. Every string that came from the
 * desktop is escaped before it lands in mrkdwn; plain_text fields render
 * literally and are only length-capped.
 */
import type { SlackBlock } from './slack-api.js';
import { SLASH_COMMAND } from './protocol.js';
import { escapeSlackText } from './sanitize.js';

export const ACTION_IDS = {
  approvalAllow: 'growth_approval_allow',
  approvalDeny: 'growth_approval_deny',
  chatOpen: 'growth_chat_open',
  chatNew: 'growth_chat_new',
} as const;

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
    text: `Working on it… ${label}`,
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
        context(`:x: Something went wrong after ${elapsed}. Check York IE on your computer.`),
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
    section(`:raised_hand: *York IE wants to run \`${tool}\`*\n${escapeSlackText(input.summary)}`),
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
  return { text: `York IE wants to run ${input.toolName}: ${input.summary}`, blocks };
}

export function renderChatList(
  chats: Array<{ token: string; title: string; updatedLabel: string; current: boolean }>
): RenderedMessage {
  const blocks: SlackBlock[] = [section('*Your recent York IE chats*')];
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
  return { text: 'Your recent York IE chats', blocks };
}

export function helpText(command: string = SLASH_COMMAND): string {
  const c = /^\/[a-z0-9_-]{1,31}$/i.test(command) ? command : SLASH_COMMAND;
  return [
    '*Control York IE from Slack*',
    'Just send a message to work in your current chat. Or use:',
    `• \`${c} new\` (or \`${c} new <message>\`) – start a fresh chat`,
    `• \`${c} chats\` – pick one of your recent chats`,
    `• \`${c} stop\` – stop what York IE is doing`,
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
