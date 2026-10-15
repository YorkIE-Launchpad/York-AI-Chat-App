/**
 * Public Slack interactivity endpoint (`POST /slack/interactions`) for relay
 * buttons: approval Allow/Deny, chat picker Open, and New chat.
 *
 * Acks with an empty 200 immediately (Slack's 3-second rule); the decision is
 * relayed and cards are updated afterwards. Only the registered owner's clicks,
 * in their own IM with the bot, are honored.
 */
import express, { type Request, type Response, type Router } from 'express';
import { ACTION_IDS, parseQuestionOptionValue } from './blocks.js';
import type { SlackRelayConfig } from './config.js';
import type { OwnerActionResult, SlackRelayHub } from './relay-hub.js';
import type { SlackApi } from './slack-api.js';
import {
  afterAck,
  rawSlackBody,
  respondEphemeral,
  resultMessage,
  verifiedRawBody,
} from './slack-request.js';

export interface ParsedBlockAction {
  teamId: string;
  userId: string;
  channelId: string;
  actionId: string;
  value: string;
  dedupeKey: string;
  responseUrl?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Narrow a signed interaction payload to one block action from the pinned app and team. */
export function toBlockAction(
  payload: Record<string, unknown>,
  config: SlackRelayConfig
): ParsedBlockAction | null {
  if (payload.type !== 'block_actions') return null;
  if (payload.api_app_id !== config.appId) return null;
  const user = asRecord(payload.user);
  const team = asRecord(payload.team);
  const channel = asRecord(payload.channel);
  const teamId = str(team?.id) || str(user?.team_id);
  if (teamId !== config.teamId) return null;

  const userId = str(user?.id);
  const channelId = str(channel?.id);
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const action = asRecord(actions[0]);
  const actionId = str(action?.action_id);
  const value = str(action?.value);
  if (!/^[UW][A-Z0-9]{1,30}$/.test(userId) || !/^D[A-Z0-9]{1,30}$/.test(channelId)) return null;
  if (!actionId || !value || value.length > 128) return null;

  const dedupe = str(payload.trigger_id) || `${str(action?.action_ts)}:${actionId}:${value}`;
  const responseUrl = str(payload.response_url) || undefined;
  return { teamId, userId, channelId, actionId, value, dedupeKey: `ia:${dedupe}`, responseUrl };
}

function dispatch(action: ParsedBlockAction, hub: SlackRelayHub): OwnerActionResult | null {
  const who = { teamId: action.teamId, userId: action.userId };
  switch (action.actionId) {
    case ACTION_IDS.approvalAllow:
    case ACTION_IDS.approvalDeny:
      return hub.clickApproval({
        ...who,
        channelId: action.channelId,
        approvalId: action.value,
        decision: action.actionId === ACTION_IDS.approvalAllow ? 'allow' : 'deny',
      });
    case ACTION_IDS.questionOption: {
      const parsed = parseQuestionOptionValue(action.value);
      if (!parsed) return 'unknown';
      return hub.clickQuestion({
        ...who,
        channelId: action.channelId,
        questionId: parsed.questionId,
        action: { kind: 'option', q: parsed.q, o: parsed.o },
      });
    }
    case ACTION_IDS.questionSubmit:
    case ACTION_IDS.questionSkip:
      return hub.clickQuestion({
        ...who,
        channelId: action.channelId,
        questionId: action.value,
        action: { kind: action.actionId === ACTION_IDS.questionSubmit ? 'submit' : 'skip' },
      });
    case ACTION_IDS.chatOpen:
      if (hub.ownerImChannel(action.teamId, action.userId) !== action.channelId) return 'unknown';
      return hub.dispatchCommand({ ...who, name: 'open', token: action.value });
    case ACTION_IDS.pick:
      if (hub.ownerImChannel(action.teamId, action.userId) !== action.channelId) return 'unknown';
      return hub.dispatchCommand({ ...who, name: 'pick', token: action.value });
    case ACTION_IDS.chatNew:
      if (hub.ownerImChannel(action.teamId, action.userId) !== action.channelId) return 'unknown';
      return hub.dispatchCommand({ ...who, name: 'new' });
    default:
      return null;
  }
}

export function createSlackInteractionsRouter(deps: {
  config: SlackRelayConfig | null;
  hub: SlackRelayHub | null;
  api: SlackApi | null;
}): Router {
  const router = express.Router();

  router.post('/interactions', rawSlackBody, (req: Request, res: Response) => {
    const { config, hub, api } = deps;
    if (!config || !hub || !api) {
      res.status(503).json({ error: 'slack_relay_disabled' });
      return;
    }
    const rawBody = verifiedRawBody(req, config);
    if (rawBody === null) {
      res.status(401).json({ error: 'invalid_signature' });
      return;
    }

    let payload: Record<string, unknown> | null = null;
    try {
      payload = asRecord(JSON.parse(new URLSearchParams(rawBody).get('payload') ?? ''));
    } catch {
      payload = null;
    }
    if (!payload) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }

    const action = toBlockAction(payload, config);
    res.status(200).end();
    if (!action || !hub.markEventSeen(action.dedupeKey)) return;

    afterAck('interaction', async () => {
      const result = dispatch(action, hub);
      if (result && result !== 'ok') {
        await respondEphemeral(api, action.responseUrl, resultMessage(result));
      }
    });
  });

  return router;
}
