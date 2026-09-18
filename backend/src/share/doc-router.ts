import { Router, type Request, type Response } from 'express';
import {
  canEdit,
  canView,
  getDocAccess,
  normalizePermission,
  resolveCallerFromPayload,
} from './doc-access.js';
import { signDocInvite, verifyDocInvite } from './doc-invite.js';
import {
  createSharedDoc,
  getSharedDoc,
  listSharedDocsForCaller,
  patchSharedDocVersion,
  removeAcl,
  upsertAcl,
} from './doc-store.js';
import type { SharedDocKind, SharedDocWithAccess } from './types.js';

type CognitoRequest = Request & {
  cognito?: { payload: Record<string, unknown>; tokenUse: 'id' | 'access' };
};

function withAccess(doc: ReturnType<typeof getSharedDoc>, access: NonNullable<ReturnType<typeof getDocAccess>>): SharedDocWithAccess | null {
  if (!doc) return null;
  return { ...doc, permission: access };
}

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

  router.post('/', (req: CognitoRequest, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;

    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const s3Key = typeof req.body?.s3Key === 'string' ? req.body.s3Key.trim() : '';
    const contentType =
      typeof req.body?.contentType === 'string' ? req.body.contentType.trim() : 'text/plain';
    const kind = parseKind(req.body?.kind);

    if (!title || title.length > 500) {
      res.status(400).json({ error: 'title is required (max 500 chars)' });
      return;
    }
    if (!s3Key || s3Key.length > 1024) {
      res.status(400).json({ error: 's3Key is required' });
      return;
    }
    if (!kind) {
      res.status(400).json({ error: 'kind must be html or markdown' });
      return;
    }

    const doc = createSharedDoc({
      ownerSub: caller.sub,
      ownerEmail: caller.email ?? '',
      title,
      kind,
      s3Key,
      contentType,
    });
    res.status(201).json(withAccess(doc, 'owner'));
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

    const doc = getSharedDoc(verified.payload.docId);
    if (!doc) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }

    const principal = caller.email || caller.sub;
    const updated = upsertAcl(doc.id, principal, verified.payload.permission);
    const access = getDocAccess(updated!, caller);
    res.json(withAccess(updated, access!));
  });

  router.get('/', (req: CognitoRequest, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;

    const docs = listSharedDocsForCaller(caller.sub, caller.email);
    const withPerms = docs
      .map((doc) => {
        const access = getDocAccess(doc, caller);
        if (!access || !canView(access)) return null;
        return withAccess(doc, access);
      })
      .filter(Boolean);
    res.json({ docs: withPerms });
  });

  router.get('/:id', (req: CognitoRequest, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;

    const doc = getSharedDoc(req.params.id);
    if (!doc) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    const access = getDocAccess(doc, caller);
    if (!access || !canView(access)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    res.json(withAccess(doc, access));
  });

  router.patch('/:id', (req: CognitoRequest, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;

    const doc = getSharedDoc(req.params.id);
    if (!doc) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    const access = getDocAccess(doc, caller);
    if (!canEdit(access)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const s3Key = typeof req.body?.s3Key === 'string' ? req.body.s3Key.trim() : '';
    const expectedVersion = Number(req.body?.expectedVersion);
    if (!s3Key) {
      res.status(400).json({ error: 's3Key is required' });
      return;
    }
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      res.status(400).json({ error: 'expectedVersion must be a positive integer' });
      return;
    }

    const result = patchSharedDocVersion(doc.id, {
      s3Key,
      updatedBy: caller.sub,
      expectedVersion,
    });
    if (!result.ok) {
      if (result.error === 'version_conflict') {
        res.status(409).json({ error: 'version_conflict', doc: getSharedDoc(doc.id) });
        return;
      }
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    res.json(withAccess(result.doc, access!));
  });

  router.post('/:id/acl', (req: CognitoRequest, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;

    const doc = getSharedDoc(req.params.id);
    if (!doc) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    if (getDocAccess(doc, caller) !== 'owner') {
      res.status(403).json({ error: 'Only owner can update ACL' });
      return;
    }

    const principal =
      typeof req.body?.principal === 'string' ? req.body.principal.trim().toLowerCase() : '';
    const permission = normalizePermission(req.body?.permission);
    if (!principal || principal.length > 320) {
      res.status(400).json({ error: 'principal is required' });
      return;
    }
    if (!permission) {
      res.status(400).json({ error: 'permission must be view or edit' });
      return;
    }

    const updated = upsertAcl(doc.id, principal, permission);
    res.json(withAccess(updated, 'owner'));
  });

  router.delete('/:id/acl/:principal', (req: CognitoRequest, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;

    const doc = getSharedDoc(req.params.id);
    if (!doc) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    if (getDocAccess(doc, caller) !== 'owner') {
      res.status(403).json({ error: 'Only owner can update ACL' });
      return;
    }

    const principal = decodeURIComponent(req.params.principal).trim().toLowerCase();
    const updated = removeAcl(doc.id, principal);
    res.json(withAccess(updated, 'owner'));
  });

  router.post('/:id/invite', (req: CognitoRequest, res: Response) => {
    const caller = requireCaller(req, res);
    if (!caller) return;

    const doc = getSharedDoc(req.params.id);
    if (!doc) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    if (getDocAccess(doc, caller) !== 'owner') {
      res.status(403).json({ error: 'Only owner can create invites' });
      return;
    }

    const permission = normalizePermission(req.body?.permission) ?? 'view';
    const ttlSec = Number(req.body?.ttlSec);
    const inviteToken = signDocInvite(doc.id, permission, {
      ttlSec: Number.isFinite(ttlSec) && ttlSec > 60 ? Math.min(ttlSec, 30 * 24 * 3600) : undefined,
    });
    res.json({ docId: doc.id, permission, inviteToken });
  });

  return router;
}
