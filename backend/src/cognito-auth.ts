import type { NextFunction, Request, Response } from 'express';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { SimpleJwksCache } from 'aws-jwt-verify/jwk';

type CognitoJwtPayload = Record<string, unknown>;

type CognitoVerifyResult =
  | { ok: true; payload: CognitoJwtPayload; tokenUse: 'id' | 'access' }
  | { ok: false; error: string };

let cognitoIdVerifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;
let cognitoAccessVerifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;
let jwksCache: SimpleJwksCache | null = null;

function getCognitoEnv(): { userPoolId: string | undefined; clientId: string | undefined } {
  const userPoolId =
    process.env.AWS_COGNITO_USER_POOL_ID?.trim() ||
    process.env.COGNITO_USER_POOL_ID?.trim() ||
    undefined;
  const clientId =
    process.env.AWS_COGNITO_APP_CLIENT_ID?.trim() ||
    process.env.COGNITO_APP_CLIENT_ID?.trim() ||
    undefined;
  return { userPoolId, clientId };
}

function getJwksCache(): SimpleJwksCache {
  if (!jwksCache) {
    jwksCache = new SimpleJwksCache();
  }
  return jwksCache;
}

function getCognitoIdVerifier() {
  const { userPoolId, clientId } = getCognitoEnv();
  if (!userPoolId || !clientId) return null;
  if (!cognitoIdVerifier) {
    cognitoIdVerifier = CognitoJwtVerifier.create(
      { userPoolId, tokenUse: 'id', clientId },
      { jwksCache: getJwksCache() }
    );
  }
  return cognitoIdVerifier;
}

function getCognitoAccessVerifier() {
  const { userPoolId, clientId } = getCognitoEnv();
  if (!userPoolId || !clientId) return null;
  if (!cognitoAccessVerifier) {
    cognitoAccessVerifier = CognitoJwtVerifier.create(
      { userPoolId, tokenUse: 'access', clientId },
      { jwksCache: getJwksCache() }
    );
  }
  return cognitoAccessVerifier;
}

function decodeJwtPayloadUnsafe(token: string): CognitoJwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as CognitoJwtPayload;
  } catch {
    return null;
  }
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^\s*Bearer\s+(.+?)\s*$/i.exec(header);
  return match?.[1]?.trim() || null;
}

/** Prefer Authorization Bearer, then x-api-key, then x-goog-api-key. */
export function extractClientAuthToken(req: Request): string | null {
  const fromAuth = extractBearerToken(
    typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined
  );
  if (fromAuth) return fromAuth;

  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim();
  if (Array.isArray(apiKey) && apiKey[0]?.trim()) return apiKey[0].trim();

  const googKey = req.headers['x-goog-api-key'];
  if (typeof googKey === 'string' && googKey.trim()) return googKey.trim();
  if (Array.isArray(googKey) && googKey[0]?.trim()) return googKey[0].trim();

  return null;
}

export async function verifyCognitoTokenDetailed(token: string): Promise<CognitoVerifyResult> {
  const idVerifier = getCognitoIdVerifier();
  const accessVerifier = getCognitoAccessVerifier();
  if (!idVerifier && !accessVerifier) {
    return {
      ok: false,
      error:
        'Cognito not configured — set AWS_COGNITO_USER_POOL_ID and AWS_COGNITO_APP_CLIENT_ID in backend/.env',
    };
  }

  const hint = decodeJwtPayloadUnsafe(token);
  const tokenUse = hint?.token_use;
  const tryOrder: Array<'id' | 'access'> =
    tokenUse === 'access' ? ['access', 'id'] : ['id', 'access'];

  const errors: string[] = [];
  for (const use of tryOrder) {
    const verifier = use === 'id' ? idVerifier : accessVerifier;
    if (!verifier) continue;
    try {
      const payload = (await verifier.verify(token)) as CognitoJwtPayload;
      return { ok: true, payload, tokenUse: use };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`${use}: ${msg}`);
    }
  }

  const iss = typeof hint?.iss === 'string' ? hint.iss : 'unknown';
  const aud = hint?.aud ?? hint?.client_id ?? 'unknown';
  return {
    ok: false,
    error: `Cognito JWT verification failed (iss=${iss}, aud=${String(aud)}). ${errors.join('; ')}`,
  };
}

export async function requireCognito(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = extractClientAuthToken(req);
  if (!token) {
    res.status(401).json({
      error: 'Authentication required',
      message: 'Provide a Cognito JWT via Authorization: Bearer, x-api-key, or x-goog-api-key',
    });
    return;
  }

  const result = await verifyCognitoTokenDetailed(token);
  if (!result.ok) {
    res.status(401).json({
      error: 'Authentication failed',
      message: result.error,
    });
    return;
  }

  next();
}
