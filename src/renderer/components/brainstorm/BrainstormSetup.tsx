import { useEffect, useState } from 'react';
import type {
  BrainstormProfileSnapshot,
  BrainstormTechnique,
} from '../../../shared/brainstorm-types';
import {
  BRAINSTORM_TECHNIQUES,
  BRAINSTORM_TECHNIQUE_LABELS,
  BRAINSTORM_TECHNIQUE_DESCRIPTIONS,
  emptyProfileSnapshot,
} from '../../../shared/brainstorm-types';
import { useIPC } from '../../hooks/useIPC';
import { normalizeSelectedFiles } from '../../utils/load-composer-image';
import { submitBrainstormCreate } from '../../brainstorm/launch-brainstorm';
import { useAppStore } from '../../store';

export function BrainstormSetup() {
  const { invoke } = useIPC();
  const setGlobalNotice = useAppStore((s) => s.setGlobalNotice);
  const [topic, setTopic] = useState('');
  const [goal, setGoal] = useState('');
  const [technique, setTechnique] = useState<BrainstormTechnique>('auto');
  const [profile, setProfile] = useState<BrainstormProfileSnapshot>(emptyProfileSnapshot());
  const [starting, setStarting] = useState(false);
  const [files, setFiles] = useState<string[]>([]);
  const [hint, setHint] = useState<BrainstormTechnique | null>(null);

  useEffect(() => {
    let cancelled = false;
    void invoke<BrainstormProfileSnapshot>({ type: 'brainstorm.profile', payload: {} })
      .then((next) => {
        if (cancelled || !next) return;
        setProfile((current) => ({
          ...next,
          title: current.title?.trim() ? current.title : next.title,
          functionName: current.functionName?.trim() ? current.functionName : next.functionName,
          squad: current.squad?.trim() ? current.squad : next.squad,
          department: current.department?.trim() ? current.department : next.department,
          roleNote: current.roleNote?.trim() ? current.roleNote : next.roleNote,
          name: current.name?.trim() ? current.name : next.name,
          email: current.email?.trim() ? current.email : next.email,
        }));
      })
      .catch(() => {
        /* profile stays on the server if this preview fails */
      });
    return () => {
      cancelled = true;
    };
  }, [invoke]);

  const start = async () => {
    const trimmed = topic.trim();
    if (!trimmed || starting) return;
    setStarting(true);
    try {
      await submitBrainstormCreate(invoke, {
        topic: trimmed,
        goal: goal.trim() || null,
        technique,
        profile,
        filePaths: files,
      });
      setTopic('');
      setGoal('');
      setFiles([]);
    } catch (error) {
      setGlobalNotice({
        id: `brainstorm-start-${Date.now()}`,
        type: 'error',
        message: error instanceof Error ? error.message : 'Could not start the brainstorm',
      });
    } finally {
      setStarting(false);
    }
  };

  return (
    <form
      className="rounded-2xl border border-border-subtle bg-background p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}
    >
      <label
        className="block text-[12px] font-medium text-text-secondary"
        htmlFor="brainstorm-topic"
      >
        What are we brainstorming?
      </label>
      <textarea
        id="brainstorm-topic"
        value={topic}
        onChange={(event) => setTopic(event.target.value)}
        rows={3}
        placeholder="A product bet, a RevOps play, a campaign, a process…"
        className="mt-2 w-full resize-none rounded-xl border border-border-subtle bg-surface px-3 py-2 text-[15px] text-text-primary"
      />
      <label
        className="mt-3 block text-[12px] font-medium text-text-secondary"
        htmlFor="brainstorm-goal"
      >
        Goal, if you have one
      </label>
      <input
        id="brainstorm-goal"
        value={goal}
        onChange={(event) => setGoal(event.target.value)}
        placeholder="Q1 pipeline growth"
        className="mt-2 w-full rounded-xl border border-border-subtle bg-surface px-3 py-2 text-[13px] text-text-primary"
      />
      <p className="mt-3 text-[12px] font-medium text-text-secondary">Method</p>
      <div className="mt-1.5 flex flex-wrap gap-1" role="group" aria-label="Method">
        {BRAINSTORM_TECHNIQUES.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setTechnique(id)}
            onMouseEnter={() => setHint(id)}
            onMouseLeave={() => setHint((current) => (current === id ? null : current))}
            onFocus={() => setHint(id)}
            onBlur={() => setHint((current) => (current === id ? null : current))}
            aria-describedby="brainstorm-method-hint"
            className={`rounded-full px-2 py-0.5 text-[11px] ${
              technique === id
                ? 'bg-text-primary text-background'
                : 'border border-border-subtle text-text-secondary hover:bg-surface'
            }`}
          >
            {BRAINSTORM_TECHNIQUE_LABELS[id]}
          </button>
        ))}
      </div>
      <p id="brainstorm-method-hint" className="mt-1.5 text-[11px] leading-snug text-text-muted">
        {BRAINSTORM_TECHNIQUE_DESCRIPTIONS[hint ?? technique]}
      </p>
      <div
        className="mt-3 rounded-xl border border-dashed border-border-subtle px-3 py-2"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const dropped = [...event.dataTransfer.files]
            .map((file) => (file as File & { path?: string }).path)
            .filter((path): path is string => Boolean(path));
          if (dropped.length > 0) setFiles((current) => [...current, ...dropped]);
        }}
      >
        <button
          type="button"
          onClick={() => {
            void window.electronAPI?.selectFiles?.().then((selected) => {
              const paths = normalizeSelectedFiles(selected || []).map((file) => file.path);
              if (paths.length > 0) setFiles((current) => [...current, ...paths]);
            });
          }}
          className="text-[12.5px] text-text-secondary underline"
        >
          Add files
        </button>
        <p className="mt-1 text-[11px] text-text-muted">
          PDF, Word, Excel, slides, CSV, or text. Used as context, not shown as your profile.
        </p>
        {files.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {files.map((path) => (
              <li key={path} className="truncate text-[12px] text-text-secondary">
                {path.split(/[/\\]/).pop()}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <button
        type="submit"
        disabled={!topic.trim() || starting}
        className="mt-4 rounded-full bg-text-primary px-4 py-1.5 text-[13px] text-background disabled:opacity-40"
      >
        {starting ? 'Starting…' : 'Start brainstorm'}
      </button>
    </form>
  );
}
