import { Router, type Request, type Response } from 'express';
import {
  accessForCaller,
  docFromInvitePayload,
  normalizePermission,
  resolveCallerFromPayload,
} from './doc-access.js';
import { signDocInvite, verifyDocInvite } from './doc-invite.js';
import type { SharedDocKind } from './types.js';

type CognitoRequest = Request & {
  cognito?: { payload: Record<string, unknown>; tokenUse: 'id' | 'access' };
};

function requireCaller(req: CognitoRequest, res: Response) {
  const caller = resolveCallerFromPayload(req.cognito?.payload ?? {});
  if (!caller) {
    res.status(401).json({ error: 'Cognito sub missing' });
    return null;
  }
  return caller;
}

function parseKind(value: unknown): SharedDocKind | null {
  if (value === 'html' || value === 'markdown') return value;
  return null;
}

export function createShareDocRouter(): Router {
  const router = Router();

  router.post('/invite', (req: CognitoRequest, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;

    const docId = typeof req.body?.docId === 'string' ? req.body.docId.trim() : '';
    const s3Key = typeof req.body?.s3Key === 'string' ? req.body.s3Key.trim() : '';
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const contentType =
      typeof req.body?.contentType === 'string' ? req.body.contentType.trim() : 'text/plain';
    const kind = parseKind(req.body?.kind);
    const permission = normalizePermission(req.body?.permission) ?? 'view';

    if (!docId || docId.length > 128) {
      res.status(400).json({ error: 'docId is required (max 128 chars)' });
      return;
    }
    if (!s3Key || s3Key.length > 1024) {
      res.status(400).json({ error: 's3Key is required' });
      return;
    }
    if (!title || title.length > 500) {
      res.status(400).json({ error: 'title is required (max 500 chars)' });
      return;
    }
    if (!kind) {
      res.status(400).json({ error: 'kind must be html or markdown' });
      return;
    }

    const ttlSec = Number(req.body?.ttlSec);
    try {
      const inviteToken = signDocInvite(
        {
          docId,
          s3Key,
          title,
          kind,
          contentType,
          ownerSub: caller.sub,
          ownerEmail: caller.email ?? '',
        },
        permission,
        {
          ttlSec:
            Number.isFinite(ttlSec) && ttlSec > 60
              ? Math.min(ttlSec, 30 * 24 * 3600)
              : undefined,
        }
      );
      res.json({ docId, permission, inviteToken });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to sign invite',
      });
    }
  });

  router.post('/join', (req: CognitoRequest, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;

    const inviteToken =
      typeof req.body?.inviteToken === 'string' ? req.body.inviteToken.trim() : '';
    if (!inviteToken) {
      res.status(400).json({ error: 'inviteToken is required' });
      return;
    }

    const verified = verifyDocInvite(inviteToken);
    if (!verified.ok) {
      res.status(400).json({ error: verified.error });
      return;
    }

    const permission = accessForCaller(verified.payload, caller);
    res.json(docFromInvitePayload(verified.payload, permission));
  });

  router.post('/invite/verify', (req: CognitoRequest, res: Response) => {
    const inviteToken =
      typeof req.body?.inviteToken === 'string' ? req.body.inviteToken.trim() : '';
    if (!inviteToken) {
      res.status(400).json({ error: 'inviteToken is required' });
      return;
    }
    const result = verifyDocInvite(inviteToken);
    if (!result.ok) {
      res.status(400).json({ ok: false, error: result.error });
      return;
    }
    res.json({
      ok: true,
      docId: result.payload.docId,
      permission: result.payload.permission,
      exp: result.payload.exp,
    });
  });

  return router;
}
