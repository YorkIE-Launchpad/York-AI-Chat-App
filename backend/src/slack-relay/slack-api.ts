/**
 * Minimal Slack Web API client for the relay. Only the methods the relay
 * needs, form-encoded, with a hard timeout and a single Retry-After retry.
 */

type FetchFn = typeof fetch;

const SLACK_API_BASE = 'https://slack.com/api';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRY_AFTER_SECONDS = 30;

export interface SlackIdentity {
  userId: string;
  teamId: string;
}

export interface SlackUserProfile {
  id: string;
  teamId: string;
  email: string | null;
  isBot: boolean;
  deleted: boolean;
  isRestricted: boolean;
  isUltraRestricted: boolean;
  isStranger: boolean;
}

export type SlackBlock = Record<string, unknown>;

export interface SlackApi {
  /** Resolve the identity behind a user token (xoxp-). */
  authTest(userToken: string): Promise<SlackIdentity>;
  /** Look up a workspace member with the bot token. */
  usersInfo(userId: string): Promise<SlackUserProfile>;
  /** Open (or fetch) the bot's 1:1 IM with a user. */
  openIm(userId: string): Promise<string>;
  /** Returns the posted message `ts` (empty when Slack omitted it). */
  postMessage(input: {
    channel: string;
    text: string;
    threadTs?: string;
    blocks?: SlackBlock[];
  }): Promise<{ ts: string }>;
  updateMessage(input: {
    channel: string;
    ts: string;
    text: string;
    blocks?: SlackBlock[];
  }): Promise<void>;
  addReaction(input: { channel: string; ts: string; name: string }): Promise<void>;
  removeReaction(input: { channel: string; ts: string; name: string }): Promise<void>;
  /** POST to an interaction / slash-command `response_url` (hooks.slack.com only). */
  respond(responseUrl: string, body: Record<string, unknown>): Promise<void>;
}

/** Slack `response_url`s always live on hooks.slack.com; anything else is refused. */
export function isSlackResponseUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2_000) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'hooks.slack.com';
  } catch {
    return false;
  }
}

/** Reactions that are already present / absent are not failures for our purposes. */
const BENIGN_REACTION_ERRORS = new Set(['already_reacted', 'no_reaction', 'message_not_found']);

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string
  ) {
    super(`Slack ${method} failed: ${code}`);
    this.name = 'SlackApiError';
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function createSlackApi(botToken: string, fetchFn: FetchFn = fetch): SlackApi {
  async function call(
    method: string,
    token: string,
    params: Record<string, string>,
    attempt = 0
  ): Promise<Record<string, unknown>> {
    const response = await fetchFn(`${SLACK_API_BASE}/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.status === 429 && attempt === 0) {
      const retryAfter = Number(response.headers.get('retry-after') || '1');
      const seconds = Number.isFinite(retryAfter) ? retryAfter : 1;
      if (seconds <= MAX_RETRY_AFTER_SECONDS) {
        await sleep(Math.max(1, seconds) * 1000);
        return call(method, token, params, attempt + 1);
      }
    }
    if (!response.ok) {
      throw new SlackApiError(method, `http_${response.status}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    if (payload.ok !== true) {
      throw new SlackApiError(
        method,
        typeof payload.error === 'string' ? payload.error : 'unknown'
      );
    }
    return payload;
  }

  return {
    async authTest(userToken) {
      const payload = await call('auth.test', userToken, {});
      const userId = typeof payload.user_id === 'string' ? payload.user_id : '';
      const teamId = typeof payload.team_id === 'string' ? payload.team_id : '';
      if (!userId || !teamId) throw new SlackApiError('auth.test', 'missing_identity');
      return { userId, teamId };
    },

    async usersInfo(userId) {
      const payload = await call('users.info', botToken, { user: userId });
      const user =
        payload.user && typeof payload.user === 'object'
          ? (payload.user as Record<string, unknown>)
          : null;
      if (!user || user.id !== userId) throw new SlackApiError('users.info', 'missing_user');
      const profile =
        user.profile && typeof user.profile === 'object'
          ? (user.profile as Record<string, unknown>)
          : {};
      return {
        id: userId,
        teamId: typeof user.team_id === 'string' ? user.team_id : '',
        email: typeof profile.email === 'string' ? profile.email : null,
        isBot: user.is_bot === true || user.is_app_user === true,
        deleted: user.deleted === true,
        isRestricted: user.is_restricted === true,
        isUltraRestricted: user.is_ultra_restricted === true,
        isStranger: user.is_stranger === true,
      };
    },

    async openIm(userId) {
      const payload = await call('conversations.open', botToken, { users: userId });
      const channel =
        payload.channel && typeof payload.channel === 'object'
          ? (payload.channel as Record<string, unknown>)
          : null;
      const id = typeof channel?.id === 'string' ? channel.id : '';
      if (!id.startsWith('D')) throw new SlackApiError('conversations.open', 'not_an_im');
      return id;
    },

    async postMessage({ channel, text, threadTs, blocks }) {
      const params: Record<string, string> = {
        channel,
        text,
        parse: 'none',
        link_names: 'false',
        unfurl_links: 'false',
        unfurl_media: 'false',
        mrkdwn: 'true',
      };
      if (threadTs) params.thread_ts = threadTs;
      if (blocks) params.blocks = JSON.stringify(blocks);
      const payload = await call('chat.postMessage', botToken, params);
      return { ts: typeof payload.ts === 'string' ? payload.ts : '' };
    },

    async updateMessage({ channel, ts, text, blocks }) {
      const params: Record<string, string> = {
        channel,
        ts,
        text,
        parse: 'none',
        link_names: 'false',
        blocks: JSON.stringify(blocks ?? []),
      };
      await call('chat.update', botToken, params);
    },

    async addReaction({ channel, ts, name }) {
      try {
        await call('reactions.add', botToken, { channel, timestamp: ts, name });
      } catch (error) {
        if (!(error instanceof SlackApiError && BENIGN_REACTION_ERRORS.has(error.code)))
          throw error;
      }
    },

    async removeReaction({ channel, ts, name }) {
      try {
        await call('reactions.remove', botToken, { channel, timestamp: ts, name });
      } catch (error) {
        if (!(error instanceof SlackApiError && BENIGN_REACTION_ERRORS.has(error.code)))
          throw error;
      }
    },

    async respond(responseUrl, body) {
      if (!isSlackResponseUrl(responseUrl)) {
        throw new SlackApiError('response_url', 'invalid_url');
      }
      const response = await fetchFn(responseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new SlackApiError('response_url', `http_${response.status}`);
    },
  };
}
