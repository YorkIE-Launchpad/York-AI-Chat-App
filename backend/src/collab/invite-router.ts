/**
 * Cognito-gated HTTP routes for collab invites (stateless HMAC JWTs).
 */
import { Router, type Request, type Response } from 'express';
import { signCollabInvite, verifyCollabInvite } from './invite.js';

type CognitoRequest = Request & {
  cognito?: { payload: Record<string, unknown>; tokenUse: 'id' | 'access' };
};

export function createCollabInviteRouter(): Router {
  const router = Router();

  router.post('/invite', (req: CognitoRequest, res: Response) => {
    const roomId =
      typeof req.body?.roomId === 'string' ? req.body.roomId.trim() : '';
    if (!roomId || roomId.length > 128) {
      res.status(400).json({ error: 'roomId is required (max 128 chars)' });
      return;
    }

    const sub = req.cognito?.payload?.sub;
    if (typeof sub !== 'string' || !sub.trim()) {
      res.status(401).json({ error: 'Cognito sub missing' });
      return;
    }

    try {
      const inviteToken = signCollabInvite(roomId);
      res.json({ roomId, inviteToken });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to sign invite',
      });
    }
  });

  /** Optional client-side check before opening WS. */
  router.post('/invite/verify', (req: CognitoRequest, res: Response) => {
    const inviteToken =
      typeof req.body?.inviteToken === 'string' ? req.body.inviteToken.trim() : '';
    const roomId =
      typeof req.body?.roomId === 'string' ? req.body.roomId.trim() : undefined;
    if (!inviteToken) {
      res.status(400).json({ error: 'inviteToken is required' });
      return;
    }
    const result = verifyCollabInvite(inviteToken, roomId);
    if (!result.ok) {
      res.status(400).json({ ok: false, error: result.error });
      return;
    }
    res.json({
      ok: true,
      roomId: result.payload.roomId,
      exp: result.payload.exp,
    });
  });

  return router;
}
