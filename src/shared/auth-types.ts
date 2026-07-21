export type AuthUserRole = 'admin' | 'manager';

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: AuthUserRole;
  image?: string | null;
}

export interface AuthSessionPayload {
  user: AuthUser;
  idToken: string;
  accessToken: string;
  refreshToken: string;
}

export interface AuthStatusResponse {
  user: AuthUser | null;
  tokens?: {
    token: string;
    accessToken: string;
    refreshToken: string;
  } | null;
}

export interface AuthMeResponse {
  user: AuthUser;
}

export interface AuthOAuthDebugInfo {
  hubApiUrl: string;
  oauthRedirectUrl: string;
  /** Redirect URL computed in the renderer (Vite env); compare to oauthRedirectUrl for mismatch. */
  rendererOAuthRedirectUrl: string | null;
  redirectUrlMismatch: boolean;
  callbackMode: 'vite-callback-relay' | 'loopback';
  viteDevServerUrl: string | null;
  /** Hub GET /api/auth/google?redirect_url=… (before Hub returns Google URL). */
  googleOAuthStartApiUrl: string;
  googleAuthUrl: string | null;
  googleAuthUrlError: string | null;
  /** redirect_uri query param from Google OAuth URL (must match oauthRedirectUrl). */
  cognitoRedirectUri: string | null;
  oauthRelayBaseUrl: string;
  oauthRelayListening: boolean;
  browserRelayPostUrl: string;
}
