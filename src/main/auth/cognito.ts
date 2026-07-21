import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { SimpleJwksCache } from 'aws-jwt-verify/jwk';
import { authConfig } from '../../shared/auth-config';
import { logWarn } from '../utils/logger';

let cognitoIdVerifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;
let cognitoAccessVerifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;
let jwksCache: SimpleJwksCache | null = null;

function getCognitoEnv() {
  const userPoolId = authConfig.cognitoUserPoolId;
  const clientId = authConfig.cognitoAppClientId;
  return { userPoolId, clientId };
}

function getJwksCache(): SimpleJwksCache {
  if (!jwksCache) {
    jwksCache = new SimpleJwksCache();
  }
  return jwksCache;
}

export function getCognitoVerifier() {
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

export function getCognitoAccessVerifier() {
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

export async function warmupJwksCache(): Promise<void> {
  const { userPoolId } = getCognitoEnv();
  if (!userPoolId) return;
  try {
    const verifier = getCognitoVerifier();
    if (!verifier) return;
    const { jwksUri } = CognitoJwtVerifier.parseUserPoolId(userPoolId);
    await getJwksCache().getJwks(jwksUri);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logWarn('[Auth] Cognito JWKS warmup failed:', msg);
  }
}

export type CognitoJwtPayload = Record<string, unknown>;

export type CognitoVerifyResult =
  | { ok: true; payload: CognitoJwtPayload; tokenUse: 'id' | 'access' }
  | { ok: false; error: string };

function decodeJwtPayloadUnsafe(token: string): CognitoJwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as CognitoJwtPayload;
  } catch {
    return null;
  }
}

export async function verifyCognitoTokenDetailed(token: string): Promise<CognitoVerifyResult> {
  const idVerifier = getCognitoVerifier();
  const accessVerifier = getCognitoAccessVerifier();
  if (!idVerifier && !accessVerifier) {
    return {
      ok: false,
      error:
        'Cognito not configured — set AWS_COGNITO_USER_POOL_ID and AWS_COGNITO_APP_CLIENT_ID in .env',
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

export async function verifyCognitoToken(token: string): Promise<CognitoJwtPayload | null> {
  const result = await verifyCognitoTokenDetailed(token);
  return result.ok ? result.payload : null;
}

export function getEmailFromPayload(payload: CognitoJwtPayload | null): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const candidates = [
    payload.email,
    payload['cognito:username'],
    payload['custom:email'],
    payload.username,
    payload.preferred_username,
  ].filter(Boolean);
  for (const v of candidates) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (!s) continue;
    if (s.includes('@')) return s;
  }
  return null;
}
