import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import sidebarLogoSrc from '../assets/logo.png';

export function LoginPage() {
  const { checkAuth } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleGoogleSignIn = async () => {
    const authApi = window.electronAPI?.auth;
    if (!authApi) {
      setError('Sign-in is only available in the desktop app.');
      return;
    }

    setLoading(true);
    setError('');
    try {
      const result = await authApi.startGoogleLogin();
      if (!result.success) {
        setError(result.error || 'Could not complete sign-in.');
        return;
      }
      await checkAuth();
    } catch {
      setError('Could not start Google sign-in. Try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-full w-full flex flex-col items-center justify-center bg-background px-6">
      <div className="w-full max-w-md rounded-[1.75rem] border border-border-subtle bg-background/80 p-8 shadow-sm">
        <div className="flex flex-col items-center text-center gap-6">
          <div className="flex items-center gap-3">
            <img
              src={sidebarLogoSrc}
              alt=""
              className="h-14 w-14 rounded-2xl object-contain flex-shrink-0"
            />
            <span className="text-[1.34rem] leading-none font-semibold tracking-[-0.035em] text-text-primary">
              York IE VECOS
            </span>
          </div>
          <div className="space-y-2">
            <h1 className="text-xl font-semibold text-text-primary">Sign in to continue</h1>
            <p className="text-sm text-text-muted">
              Use your York IE Google account to access VECOS.
            </p>
          </div>

          {error ? (
            <p
              className="w-full text-sm text-red-500 bg-red-500/10 rounded-lg px-3 py-2 text-left"
              role="alert"
            >
              {error}
            </p>
          ) : null}

          <button
            type="button"
            onClick={() => void handleGoogleSignIn()}
            disabled={loading}
            className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-text-primary text-background px-4 py-3 text-sm font-medium disabled:opacity-60"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Sign in with Google
          </button>
        </div>
      </div>
    </div>
  );
}
