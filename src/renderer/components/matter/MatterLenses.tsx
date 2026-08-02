import type { MatterLens, MatterLensId } from '../../../shared/matter';

const STATUS_COLOR: Record<string, string> = {
  ACTIVE: 'text-red-400',
  MONITORING: 'text-amber-400',
  COORDINATING: 'text-sky-400',
  CLEAR: 'text-emerald-400',
};

interface MatterLensesProps {
  lenses: MatterLens[];
  activeLens: MatterLensId | null;
  onSelect: (id: MatterLensId | null) => void;
}

export function MatterLenses({ lenses, activeLens, onSelect }: MatterLensesProps) {
  const activeCount = lenses.filter((l) => l.status === 'ACTIVE' || l.count > 0).length;

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center justify-between px-1 mb-3">
        <h2 className="text-[11px] font-semibold tracking-[0.18em] text-text-muted uppercase">
          Focus lenses
        </h2>
        <span className="text-[10px] rounded-full border border-border-subtle px-2 py-0.5 text-text-muted">
          {activeCount} active
        </span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
        {lenses.map((lens) => {
          const selected = activeLens === lens.id;
          return (
            <button
              key={lens.id}
              type="button"
              onClick={() => onSelect(selected ? null : lens.id)}
              className={`w-full text-left rounded-xl border px-3 py-2.5 transition-colors ${
                selected
                  ? 'border-accent/50 bg-accent-muted/15'
                  : 'border-border-muted bg-background/50 hover:bg-surface-hover/40'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-semibold text-text-primary">{lens.label}</span>
                <span
                  className={`text-[10px] font-semibold tracking-wide ${STATUS_COLOR[lens.status] || 'text-text-muted'}`}
                >
                  {lens.status}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-text-secondary leading-relaxed line-clamp-3">
                {lens.summary}
              </p>
              {lens.count > 0 ? (
                <p className="mt-1.5 text-[10px] text-text-muted">{lens.count} signals</p>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
