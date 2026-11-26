import type { BrainstormPhase } from '../../../shared/brainstorm-types';
import { BRAINSTORM_PHASES, BRAINSTORM_PHASE_LABELS } from '../../../shared/brainstorm-types';

export function PhaseStepper({ phase }: { phase: BrainstormPhase }) {
  const current = Math.max(0, BRAINSTORM_PHASES.indexOf(phase));
  return (
    <ol className="flex w-full items-start" aria-label="Brainstorm phase">
      {BRAINSTORM_PHASES.map((step, index) => {
        const state = index < current ? 'done' : index === current ? 'now' : 'later';
        const last = index === BRAINSTORM_PHASES.length - 1;
        return (
          <li key={step} className="flex min-w-0 flex-1 flex-col items-center">
            <div className="flex h-3 w-full items-center">
              <span
                className={`h-px flex-1 ${
                  index === 0
                    ? 'bg-transparent'
                    : index <= current
                      ? 'bg-text-primary/45'
                      : 'bg-border-subtle'
                }`}
              />
              <span
                className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                  state === 'now'
                    ? 'animate-pulse bg-text-primary shadow-[0_0_0_4px] shadow-text-primary/20'
                    : state === 'done'
                      ? 'bg-text-primary'
                      : 'border border-border-subtle bg-background'
                }`}
                aria-current={state === 'now' ? 'step' : undefined}
              />
              <span
                className={`h-px flex-1 ${
                  last
                    ? 'bg-transparent'
                    : index < current
                      ? 'bg-text-primary/45'
                      : 'bg-border-subtle'
                }`}
              />
            </div>
            <span
              className={`mt-1.5 px-0.5 text-center text-[10px] leading-tight ${
                state === 'now' ? 'font-semibold text-text-primary' : 'text-text-muted'
              }`}
            >
              {BRAINSTORM_PHASE_LABELS[step]}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
