import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useIPC } from '../hooks/useIPC';
import { useAppStore } from '../store';
import type { PermissionRequest } from '../types';
import { Shield, X, Check, AlertTriangle } from 'lucide-react';
import {
  PERMISSION_ASK_TIMEOUT_MS,
  truncatePermissionInputPreview,
} from '../../shared/permission-policy';

interface PermissionDialogProps {
  permission: PermissionRequest;
}

function formatCountdown(msRemaining: number): string {
  const totalSec = Math.max(0, Math.ceil(msRemaining / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function PermissionDialog({ permission }: PermissionDialogProps) {
  const { t } = useTranslation();
  const { respondToPermission } = useIPC();
  const queuedCount = useAppStore((s) => s.permissionQueue.length);
  const expiresAt = permission.expiresAt ?? Date.now() + PERMISSION_ASK_TIMEOUT_MS;
  const [msRemaining, setMsRemaining] = useState(() => Math.max(0, expiresAt - Date.now()));

  useEffect(() => {
    const tick = () => setMsRemaining(Math.max(0, expiresAt - Date.now()));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [expiresAt, permission.toolUseId]);

  const previewInput = useMemo(
    () => truncatePermissionInputPreview(permission.input),
    [permission.input]
  );

  const getToolDescription = (toolName: string): string => {
    const key = `permission.toolDescriptions.${toolName}`;
    const translated = t(key);
    if (translated !== key) {
      return translated;
    }
    return t('permission.useTool', { toolName });
  };

  const isHighRisk = [
    'bash',
    'write',
    'edit',
    'execute_command',
    'write_file',
    'edit_file',
  ].includes(permission.toolName.toLowerCase());

  return (
    <div className="fixed inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center z-[90] animate-fade-in">
      <div className="card w-full max-w-md p-6 m-4 shadow-elevated animate-slide-up">
        <div className="flex items-start gap-4">
          <div
            className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 ${
              isHighRisk ? 'bg-warning/10' : 'bg-accent-muted'
            }`}
          >
            {isHighRisk ? (
              <AlertTriangle className="w-6 h-6 text-warning" />
            ) : (
              <Shield className="w-6 h-6 text-accent" />
            )}
          </div>

          <div className="flex-1">
            <h2 className="text-lg font-semibold text-text-primary">
              {t('permission.permissionRequired')}
            </h2>
            <p className="text-sm text-text-secondary mt-1">
              {getToolDescription(permission.toolName)}
            </p>
            <p className="text-xs text-text-muted mt-1 tabular-nums">
              {t('permission.expiresIn', { time: formatCountdown(msRemaining) })}
            </p>
            {queuedCount > 0 ? (
              <p className="text-xs text-text-muted mt-1">
                {t('permission.moreQueued', { count: queuedCount })}
              </p>
            ) : null}
          </div>
        </div>

        <div className="mt-4 p-4 bg-surface-muted rounded-xl">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm font-medium text-text-primary">{t('permission.tool')}</span>
            <span className="font-mono text-accent text-sm">{permission.toolName}</span>
          </div>

          <div className="text-sm text-text-secondary">
            <span className="font-medium text-text-primary">{t('permission.input')}</span>
            <pre className="mt-1 text-xs code-block max-h-32 overflow-auto">
              {JSON.stringify(previewInput, null, 2)}
            </pre>
          </div>
        </div>

        {isHighRisk && (
          <div className="mt-4 p-3 bg-warning/10 border border-warning/20 rounded-xl">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-warning mt-0.5 flex-shrink-0" />
              <p className="text-sm text-warning">{t('permission.warning')}</p>
            </div>
          </div>
        )}

        <div className="mt-6 flex items-center gap-3">
          <button
            onClick={() => respondToPermission(permission.toolUseId, 'deny')}
            className="flex-1 btn btn-secondary"
          >
            <X className="w-4 h-4" />
            {t('permission.deny')}
          </button>

          <button
            onClick={() => respondToPermission(permission.toolUseId, 'allow')}
            className="flex-1 btn btn-primary"
          >
            <Check className="w-4 h-4" />
            {t('permission.allowOnce')}
          </button>
        </div>

        <button
          onClick={() => respondToPermission(permission.toolUseId, 'allow_always')}
          className="w-full mt-2 btn btn-ghost text-sm"
        >
          {t('permission.alwaysAllow')}
        </button>
      </div>
    </div>
  );
}
