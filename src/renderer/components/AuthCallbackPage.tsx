import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { authConfig, resolveOAuthRelayPostUrl } from '../../shared/auth-config';

async function deliverOAuthCodeToApp(
  code: string,
  redirectUri: string
): Promise<{ success: boolean; error?: string }> {
  const authApi = window.electronAPI?.auth;
  if (authApi?.submitOAuthCode) {
    return authApi.submitOAuthCode(code, redirectUri);
  }

  const relayUrls = [resolveOAuthRelayPostUrl(), `${authConfig.oauthRelayBaseUrl}/relay`];
  const uniqueUrls = [...new Set(relayUrls)];

  let lastError = 'Could not reach VECOS OAuth relay';
  for (const relayUrl of uniqueUrls) {
    try {
      const res = await fetch(relayUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, redirectUri }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        lastError = json.error || `Relay failed (${res.status}) at ${relayUrl}`;
        continue;
      }
      return { success: true };
    } catch (error) {
      lastError =
        error instanceof Error
          ? `${error.message} (tried ${relayUrl}; is VECOS running?)`
          : `Could not reach ${relayUrl}`;
    }
  }

  return { success: false, error: lastError };
}

function tryCloseAuthTab(): void {
  const attemptClose = () => {
    try {
      window.open('', '_self');
      window.close();
    } catch {
      // Browsers may block close for tabs not opened by script.
    }
  };
  attemptClose();
  window.setTimeout(attemptClose, 200);
  window.setTimeout(attemptClose, 800);
}

/**
 * Cognito redirects to {FRONTEND_URL}/auth/callback in the system browser.
 * This page forwards the code to Electron via IPC or the loopback relay.
 */
export function AuthCallbackPage() {
  const [message, setMessage] = useState('Completing sign-in…');
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthErr = params.get('error');
    const code = params.get('code');

    if (oauthErr) {
      setIsError(true);
      setMessage(params.get('error_description')?.replace(/\+/g, ' ') || oauthErr);
      return;
    }
    if (!code) {
      setIsError(true);
      setMessage('Missing sign-in code.');
      return;
    }

    const redirectUri = authConfig.hubOAuthRedirectUrl;

    void (async () => {
      const result = await deliverOAuthCodeToApp(code, redirectUri);
      if (result.success) {
        setMessage('Sign-in complete. Closing…');
        tryCloseAuthTab();
        window.setTimeout(() => {
          setMessage('Sign-in complete. You can close this tab and return to VECOS.');
        }, 2500);
      } else {
        setIsError(true);
        setMessage(result.error || 'Sign-in failed.');
      }
    })();
  }, []);

  return (
    <div className="h-full w-full flex flex-col items-center justify-center bg-background px-6">
      <div className="max-w-md text-center space-y-4">
        {!isError ? <Loader2 className="h-8 w-8 animate-spin mx-auto text-text-muted" /> : null}
        <p className={`text-sm ${isError ? 'text-red-500' : 'text-text-secondary'}`}>{message}</p>
      </div>
    </div>
  );
}
