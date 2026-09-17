/**
 * Server-side AI budget gate for org-key LLM proxies (anthropic / openai / gemini).
 * OpenRouter remains BYOK and is not gated here.
 *
 * When HUB_API_BASE_URL is set, verifies the caller's Hub user AI budget via
 * GET /api/users/:email/ai-budget using the same Cognito Bearer the client sent.
 * When ENFORCE_AI_BUDGET=true and Hub is unset, org-key proxies fail closed (503).
 */
import type { NextFunction, Request, Response } from 'express';
import { extractClientAuthToken } from './cognito-auth.js';
import { log, logWarn } from './safe-log.js';

type CognitoRequest = Request & {
  cognito?: { payload?: Record<string, unknown> };
};

function readEmail(payload: Record<string, unknown> | undefined): string | null {
  if (!payload) return null;
  for (const key of ['email', 'cognito:username']) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim() && value.includes('@')) {
      return value.trim();
    }
  }
  return null;
}

function normalizeStatus(raw: unknown): 'ok' | 'warning' | 'over' | 'unset' {
  if (raw === 'ok' || raw === 'warning' || raw === 'over' || raw === 'unset') return raw;
  return 'unset';
}

function hubBaseUrl(): string | null {
  const raw =
    process.env.HUB_API_BASE_URL?.trim() ||
    process.env.YORK_HUB_API_BASE_URL?.trim() ||
    '';
  return raw ? raw.replace(/\/+$/, '') : null;
}

function enforceWithoutHub(): boolean {
  const flag = process.env.ENFORCE_AI_BUDGET?.trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes';
}

async function fetchHubUserBudgetStatus(
  email: string,
  bearerToken: string
): Promise<'ok' | 'warning' | 'over' | 'unset' | 'error'> {
  const base = hubBaseUrl();
  if (!base) return 'error';

  const url = `${base}/api/users/${encodeURIComponent(email)}/ai-budget`;
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      logWarn('[budget-gate] Hub ai-budget HTTP', response.status);
      return 'error';
    }
    const json = (await response.json()) as Record<string, unknown>;
    const data =
      json.data && typeof json.data === 'object' && !Array.isArray(json.data)
        ? (json.data as Record<string, unknown>)
        : json;
    return normalizeStatus(data.status);
  } catch (error) {
    logWarn('[budget-gate] Hub ai-budget fetch failed', error);
    return 'error';
  }
}

/**
 * Express middleware for org-funded provider mounts. Skip for openrouter.
 */
export function requireOrgKeyBudget(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  void (async () => {
    const base = hubBaseUrl();
    if (!base) {
      if (enforceWithoutHub()) {
        res.status(503).json({
          error: 'AI budget enforcement requires HUB_API_BASE_URL',
        });
        return;
      }
      next();
      return;
    }

    const cognitoReq = req as CognitoRequest;
    const email = readEmail(cognitoReq.cognito?.payload);
    const token = extractClientAuthToken(req);
    if (!email || !token) {
      res.status(401).json({ error: 'Sign-in required for org model proxy' });
      return;
    }

    const status = await fetchHubUserBudgetStatus(email, token);
    if (status === 'over' || status === 'unset') {
      res.status(402).json({
        error: 'AI budget exceeded or unset. Use OpenRouter or contact an administrator.',
        status,
      });
      return;
    }
    if (status === 'error') {
      // Fail closed when Hub is configured but unreachable — prevents budget bypass.
      res.status(503).json({ error: 'Unable to verify AI budget. Try again shortly.' });
      return;
    }

    log('[budget-gate] allowed', `email=${email}`, `status=${status}`);
    next();
  })().catch((error) => {
    logWarn('[budget-gate] unexpected error', error);
    res.status(503).json({ error: 'Unable to verify AI budget. Try again shortly.' });
  });
}
