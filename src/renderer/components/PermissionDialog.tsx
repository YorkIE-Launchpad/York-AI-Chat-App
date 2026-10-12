import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useIPC } from '../hooks/useIPC';
import { useAppStore } from '../store';
import type { PermissionRequest } from '../types';
import { Shield, X, Check, AlertTriangle, PenLine, Send } from 'lucide-react';
import {
  PERMISSION_AUTO_APPROVE_MS,
  truncatePermissionInputPreview,
} from '../../shared/permission-policy';

interface PermissionDialogProps {
  permission: PermissionRequest;
}

interface DraftField {
  /** Top-level key, plus the nested key when the field lives one object level deep. */
  path: [string] | [string, string];
  label: string;
  value: string;
  multiline: boolean;
}

interface DraftMeta {
  label: string;
  value: string;
}

const DRAFT_KEYS = new Set([
  'text',
  'message',
  'body',
  'content',
  'comment',
  'description',
  'subject',
  'title',
  'summary',
  'reply',
  'note',
  'notes',
  'markdown',
  'caption',
  'text_body',
  'html_body',
  'body_text',
]);
const SINGLE_LINE_KEYS = new Set(['subject', 'title', 'summary']);
const META_KEYS = new Set([
  'to',
  'cc',
  'bcc',
  'recipient',
  'recipients',
  'channel',
  'channel_id',
  'channelid',
  'channel_name',
  'user',
  'user_id',
  'email',
  'project',
  'project_key',
  'projectkey',
  'issuekey',
  'issue_key',
  'issue_id',
  'thread_ts',
  'space',
  'page_id',
]);
const HIGH_RISK_TOOLS = ['bash', 'write', 'edit', 'execute_command', 'write_file', 'edit_file'];

function formatCountdown(msRemaining: number): string {
  const totalSec = Math.max(0, Math.ceil(msRemaining / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function humanizeKey(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function metaValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    const parts = value.filter((v) => typeof v === 'string' && v.trim()) as string[];
    return parts.length ? parts.join(', ') : null;
  }
  return null;
}

function collectDraft(input: Record<string, unknown>): { fields: DraftField[]; meta: DraftMeta[] } {
  const fields: DraftField[] = [];
  const meta: DraftMeta[] = [];
  const visit = (obj: Record<string, unknown>, parent?: string) => {
    for (const [key, value] of Object.entries(obj)) {
      const lower = key.toLowerCase();
      if (typeof value === 'string' && DRAFT_KEYS.has(lower)) {
        fields.push({
          path: parent ? [parent, key] : [key],
          label: humanizeKey(key),
          value,
          multiline: !SINGLE_LINE_KEYS.has(lower) || value.includes('\n'),
        });
      } else if (META_KEYS.has(lower)) {
        const shown = metaValue(value);
        if (shown) meta.push({ label: humanizeKey(key), value: shown });
      } else if (!parent && value && typeof value === 'object' && !Array.isArray(value)) {
        visit(value as Record<string, unknown>, key);
      }
    }
  };
  visit(input);
  fields.sort((a, b) => Number(a.multiline) - Number(b.multiline));
  return { fields, meta };
}

function fieldKey(path: DraftField['path']): string {
  return path.join('.');
}

export function PermissionDialog({ permission }: PermissionDialogProps) {
  const { t } = useTranslation();
  const { respondToPermission, holdPermission } = useIPC();
  const queuedCount = useAppStore((s) => s.permissionQueue.length);
  const expiresAt = permission.expiresAt ?? Date.now() + PERMISSION_AUTO_APPROVE_MS;
  const [msRemaining, setMsRemaining] = useState(() => Math.max(0, expiresAt - Date.now()));
  const [held, setHeld] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const firstFieldRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);

  useEffect(() => {
    setEdits({});
    setHeld(false);
  }, [permission.toolUseId]);

  useEffect(() => {
    if (held) return;
    const tick = () => setMsRemaining(Math.max(0, expiresAt - Date.now()));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [expiresAt, permission.toolUseId, held]);

  const previewInput = useMemo(
    () => truncatePermissionInputPreview(permission.input),
    [permission.input]
  );

  const isHighRisk = HIGH_RISK_TOOLS.includes(permission.toolName.toLowerCase());

  const draft = useMemo(
    () => (isHighRisk ? { fields: [], meta: [] } : collectDraft(permission.input ?? {})),
    [permission.input, isHighRisk]
  );
  const isDraft = draft.fields.length > 0;

  useEffect(() => {
    if (isDraft) firstFieldRef.current?.focus();
  }, [isDraft, permission.toolUseId]);

  const getToolDescription = (toolName: string): string => {
    const key = `permission.toolDescriptions.${toolName}`;
    const translated = t(key);
    if (translated !== key) {
      return translated;
    }
    return t('permission.useTool', { toolName });
  };

  const updateField = (field: DraftField, value: string) => {
    if (!held) {
      setHeld(true);
      holdPermission(permission.toolUseId);
    }
    setEdits((prev) => ({ ...prev, [fieldKey(field.path)]: value }));
  };

  const buildEditedInput = (): Record<string, unknown> | undefined => {
    const out: Record<string, unknown> = {};
    let changed = false;
    for (const field of draft.fields) {
      const next = edits[fieldKey(field.path)];
      if (next === undefined || next === field.value) continue;
      changed = true;
      if (field.path.length === 1) {
        out[field.path[0]] = next;
      } else {
        const [parent, child] = field.path;
        const nested = (out[parent] as Record<string, unknown> | undefined) ?? {};
        nested[child] = next;
        out[parent] = nested;
      }
    }
    return changed ? out : undefined;
  };

  const approve = (result: 'allow' | 'allow_always') => {
    respondToPermission(permission.toolUseId, result, isDraft ? buildEditedInput() : undefined);
  };

  const deny = () => respondToPermission(permission.toolUseId, 'deny');

  const editedCount = draft.fields.filter((f) => {
    const next = edits[fieldKey(f.path)];
    return next !== undefined && next !== f.value;
  }).length;

  const countdown = held ? (
    <p className="mt-1 text-xs text-text-muted">{t('permission.draft.paused')}</p>
  ) : (
    <p className="mt-1 text-xs tabular-nums text-text-muted">
      {t('permission.autoApprovesIn', { time: formatCountdown(msRemaining) })}
    </p>
  );

  if (isDraft) {
    return (
      <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in">
        <div
          className="card m-4 flex max-h-[min(720px,calc(100vh-48px))] w-full max-w-xl flex-col p-0 shadow-elevated animate-slide-up"
          role="dialog"
          aria-modal="true"
          aria-labelledby="draft-review-title"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              approve('allow');
            }
          }}
        >
          <div className="flex items-start gap-3 border-b border-border-subtle px-5 pb-4 pt-5">
            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-accent-muted">
              <PenLine className="h-[18px] w-[18px] text-accent-text" />
            </div>
            <div className="min-w-0 flex-1">
              <h2
                id="draft-review-title"
                className="text-[15px] font-semibold tracking-[-0.01em] text-text-primary"
              >
                {t('permission.draft.title')}
              </h2>
              <p className="mt-0.5 text-[13px] text-text-secondary">
                {getToolDescription(permission.toolName)}
              </p>
              {countdown}
              {queuedCount > 0 ? (
                <p className="mt-1 text-xs text-text-muted">
                  {t('permission.moreQueued', { count: queuedCount })}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={deny}
              className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-surface-hover hover:text-text-primary"
              aria-label={t('permission.draft.dontSend')}
              title={t('permission.draft.dontSend')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
            {draft.meta.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {draft.meta.map((m) => (
                  <span key={`${m.label}:${m.value}`} className="meta-chip max-w-full">
                    <span className="text-text-muted">{m.label}</span>
                    <span className="truncate text-text-primary">{m.value}</span>
                  </span>
                ))}
              </div>
            )}

            {draft.fields.map((field, index) => {
              const key = fieldKey(field.path);
              const value = edits[key] ?? field.value;
              const id = `draft-field-${key}`;
              return (
                <div key={key}>
                  <label
                    htmlFor={id}
                    className="mb-1 block text-[12px] font-semibold text-text-secondary"
                  >
                    {field.label}
                  </label>
                  {field.multiline ? (
                    <textarea
                      id={id}
                      ref={
                        index === 0
                          ? (el) => {
                              firstFieldRef.current = el;
                            }
                          : undefined
                      }
                      className="draft-field"
                      value={value}
                      rows={Math.min(14, Math.max(4, value.split('\n').length + 1))}
                      onChange={(e) => updateField(field, e.target.value)}
                      spellCheck
                    />
                  ) : (
                    <input
                      id={id}
                      ref={
                        index === 0
                          ? (el) => {
                              firstFieldRef.current = el;
                            }
                          : undefined
                      }
                      className="draft-field !min-h-0 py-2"
                      value={value}
                      onChange={(e) => updateField(field, e.target.value)}
                      spellCheck
                    />
                  )}
                </div>
              );
            })}

            <details className="group rounded-lg border border-border-subtle bg-surface-muted/60 px-3 py-2">
              <summary className="cursor-pointer select-none text-[12px] font-medium text-text-muted hover:text-text-secondary">
                {t('permission.draft.details', { tool: permission.toolName })}
              </summary>
              <pre className="code-block mt-2 max-h-40 overflow-auto text-xs">
                {JSON.stringify(previewInput, null, 2)}
              </pre>
            </details>
          </div>

          <div className="flex items-center gap-2 border-t border-border-subtle px-5 py-3.5">
            <p className="mr-auto min-w-0 flex-1 truncate text-[12px] text-text-muted">
              {editedCount > 0
                ? t('permission.draft.edited', { count: editedCount })
                : t('permission.draft.nothingSent')}
            </p>
            <button
              type="button"
              onClick={() => approve('allow_always')}
              className="btn btn-ghost btn-sm"
              title={t('permission.alwaysAllow')}
            >
              {t('permission.draft.alwaysSend')}
            </button>
            <button type="button" onClick={deny} className="btn btn-secondary btn-sm">
              {t('permission.draft.dontSend')}
            </button>
            <button
              type="button"
              onClick={() => approve('allow')}
              className="btn btn-primary btn-sm"
              title={t('permission.draft.sendHint')}
            >
              <Send className="h-3.5 w-3.5" />
              {t('permission.draft.send')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-[90] animate-fade-in">
      <div className="card w-full max-w-md p-5 m-4 shadow-elevated animate-slide-up">
        <div className="flex items-start gap-3">
          <div
            className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${
              isHighRisk ? 'bg-warning/10' : 'bg-accent-muted'
            }`}
          >
            {isHighRisk ? (
              <AlertTriangle className="w-[18px] h-[18px] text-warning" />
            ) : (
              <Shield className="w-[18px] h-[18px] text-accent-text" />
            )}
          </div>

          <div className="flex-1">
            <h2 className="text-[15px] font-semibold text-text-primary">
              {t('permission.permissionRequired')}
            </h2>
            <p className="text-[13px] text-text-secondary mt-0.5">
              {getToolDescription(permission.toolName)}
            </p>
            {countdown}
            {queuedCount > 0 ? (
              <p className="text-xs text-text-muted mt-1">
                {t('permission.moreQueued', { count: queuedCount })}
              </p>
            ) : null}
          </div>
        </div>

        <div className="mt-4 p-3.5 bg-surface-muted rounded-lg border border-border-subtle">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[13px] font-medium text-text-primary">
              {t('permission.tool')}
            </span>
            <span className="font-mono text-accent-text text-[13px]">{permission.toolName}</span>
          </div>

          <div className="text-sm text-text-secondary">
            <span className="text-[13px] font-medium text-text-primary">
              {t('permission.input')}
            </span>
            <pre className="mt-1 text-xs code-block max-h-32 overflow-auto">
              {JSON.stringify(previewInput, null, 2)}
            </pre>
          </div>
        </div>

        {isHighRisk && (
          <div className="mt-3 p-3 bg-warning/10 border border-warning/20 rounded-lg">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-warning mt-0.5 flex-shrink-0" />
              <p className="text-[13px] text-warning">{t('permission.warning')}</p>
            </div>
          </div>
        )}

        <div className="mt-5 flex items-center gap-2">
          <button onClick={deny} className="flex-1 btn btn-secondary">
            <X className="w-4 h-4" />
            {t('permission.deny')}
          </button>

          <button onClick={() => approve('allow')} className="flex-1 btn btn-primary">
            <Check className="w-4 h-4" />
            {t('permission.allowOnce')}
          </button>
        </div>

        <button
          onClick={() => approve('allow_always')}
          className="w-full mt-2 btn btn-ghost text-sm"
        >
          {t('permission.alwaysAllow')}
        </button>
      </div>
    </div>
  );
}
