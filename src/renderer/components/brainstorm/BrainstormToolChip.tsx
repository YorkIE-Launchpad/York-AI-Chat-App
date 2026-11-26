import type { ToolUseContent } from '../../types';

function countIdeas(input: Record<string, unknown>): number {
  return Array.isArray(input.ideas) ? input.ideas.length : 0;
}

export function brainstormToolLabel(block: ToolUseContent): string {
  const input = block.input || {};
  switch (block.name) {
    case 'brainstorm_add_ideas': {
      const count = countIdeas(input);
      return count === 1 ? 'Added 1 idea to the board' : `Added ${count} ideas to the board`;
    }
    case 'brainstorm_update_idea':
      return 'Updated an idea';
    case 'brainstorm_cluster':
      return 'Grouped ideas';
    case 'brainstorm_set_phase':
      return `Phase · ${typeof input.phase === 'string' ? input.phase : 'updated'}`;
    case 'brainstorm_set_context': {
      const count = Array.isArray(input.signals) ? input.signals.length : 0;
      return count > 0
        ? `Saved ${count} research signal${count === 1 ? '' : 's'}`
        : 'Updated research context';
    }
    case 'brainstorm_save_brief':
      return 'Saved the brief';
    default:
      return block.name.replace(/^brainstorm_/, '').replace(/_/g, ' ');
  }
}

export function BrainstormToolChip({ block }: { block: ToolUseContent }) {
  return (
    <div className="my-1 inline-flex max-w-full items-center rounded-full border border-border-subtle bg-surface px-2.5 py-1 text-[11px] text-text-secondary">
      {brainstormToolLabel(block)}
    </div>
  );
}
