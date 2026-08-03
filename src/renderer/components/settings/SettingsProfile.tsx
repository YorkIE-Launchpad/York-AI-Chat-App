import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { LogOut } from 'lucide-react';
import { useAppStore } from '../../store';
import { useAuth } from '../../auth/AuthContext';

const isElectron = typeof window !== 'undefined' && window.electronAPI !== undefined;

export function SettingsProfile() {
  const { t } = useTranslation();
  const { logout, user } = useAuth();
  const appConfig = useAppStore((s) => s.appConfig);
  const setAppConfig = useAppStore((s) => s.setAppConfig);

  const [dosDraft, setDosDraft] = useState('');
  const [dontsDraft, setDontsDraft] = useState('');
  const [customDraft, setCustomDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!dirty) {
      setDosDraft(appConfig?.profileDosPrompt || '');
      setDontsDraft(appConfig?.profileDontsPrompt || '');
      setCustomDraft(appConfig?.profileCustomPrompt || '');
    }
  }, [
    appConfig?.profileDosPrompt,
    appConfig?.profileDontsPrompt,
    appConfig?.profileCustomPrompt,
    dirty,
  ]);

  const savePrompts = async () => {
    if (!isElectron || saving) return;
    setSaving(true);
    setSaveMessage(null);
    try {
      const result = await window.electronAPI.config.save({
        profileDosPrompt: dosDraft,
        profileDontsPrompt: dontsDraft,
        profileCustomPrompt: customDraft,
      });
      setAppConfig(result.config);
      setDirty(false);
      setSaveMessage(t('profile.promptsSaved', 'Profile prompts saved'));
    } catch {
      setSaveMessage(t('profile.promptsSaveFailed', 'Failed to save profile prompts'));
    } finally {
      setSaving(false);
    }
  };

  const markDirty = () => {
    setDirty(true);
    setSaveMessage(null);
  };

  const textareaClassName =
    'w-full min-h-[96px] rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none resize-y';

  return (
    <div className="space-y-6">
      {user ? (
        <div className="space-y-3">
          <h4 className="text-sm font-medium text-text-primary">
            {t('profile.account', 'Account')}
          </h4>
          <p className="text-sm text-text-secondary">{user.name}</p>
          <p className="text-xs text-text-muted">{user.email}</p>
          <button
            type="button"
            onClick={() => void logout()}
            className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm text-text-secondary hover:border-accent/50 hover:text-text-primary"
          >
            <LogOut className="h-4 w-4" />
            {t('sidebar.signOut')}
          </button>
        </div>
      ) : null}

      <div className={`space-y-4 ${user ? 'pt-2 border-t border-border' : ''}`}>
        <div className="space-y-1">
          <h4 className="text-sm font-medium text-text-primary">
            {t('profile.promptsTitle', 'AI instructions')}
          </h4>
          <p className="text-sm text-text-secondary">
            {t(
              'profile.promptsHelp',
              'These rules are injected as mandatory instructions into every chat and subagent run.'
            )}
          </p>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-text-primary" htmlFor="profile-dos">
            {t('profile.dos', 'Dos')}
          </label>
          <p className="text-xs text-text-muted">
            {t('profile.dosHint', 'Things the assistant should always do.')}
          </p>
          <textarea
            id="profile-dos"
            value={dosDraft}
            onChange={(e) => {
              setDosDraft(e.target.value);
              markDirty();
            }}
            placeholder={t('profile.dosPlaceholder', 'e.g. Prefer concise bullet answers…')}
            className={textareaClassName}
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-text-primary" htmlFor="profile-donts">
            {t('profile.donts', "Don'ts")}
          </label>
          <p className="text-xs text-text-muted">
            {t('profile.dontsHint', 'Things the assistant should never do.')}
          </p>
          <textarea
            id="profile-donts"
            value={dontsDraft}
            onChange={(e) => {
              setDontsDraft(e.target.value);
              markDirty();
            }}
            placeholder={t('profile.dontsPlaceholder', 'e.g. Do not create files unless asked…')}
            className={textareaClassName}
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-text-primary" htmlFor="profile-custom">
            {t('profile.custom', 'Custom prompts')}
          </label>
          <p className="text-xs text-text-muted">
            {t('profile.customHint', 'Any other freeform instructions that must always apply.')}
          </p>
          <textarea
            id="profile-custom"
            value={customDraft}
            onChange={(e) => {
              setCustomDraft(e.target.value);
              markDirty();
            }}
            placeholder={t(
              'profile.customPlaceholder',
              'e.g. Always address me as Kalrav; default timezone IST…'
            )}
            className={textareaClassName}
          />
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={saving || !dirty}
            onClick={() => void savePrompts()}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {saving ? t('profile.saving', 'Saving…') : t('profile.savePrompts', 'Save prompts')}
          </button>
          {saveMessage && <p className="text-xs text-text-muted">{saveMessage}</p>}
        </div>
      </div>
    </div>
  );
}
