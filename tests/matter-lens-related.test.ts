import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  relatedMatterLensId,
  type MatterCategory,
  type MatterLens,
} from '../src/shared/matter';

const lensesPath = path.resolve(process.cwd(), 'src/renderer/components/matter/MatterLenses.tsx');
const pagePath = path.resolve(process.cwd(), 'src/renderer/components/matter/MatterPage.tsx');
const cssPath = path.resolve(process.cwd(), 'src/renderer/styles/globals.css');

function lens(id: MatterLens['id'], itemIds: string[] = []): MatterLens {
  return {
    id,
    label: id,
    status: 'MONITORING',
    summary: '',
    itemIds,
    count: itemIds.length,
  };
}

describe('relatedMatterLensId', () => {
  const lenses = [
    lens('delivery', ['d1']),
    lens('people', ['p1']),
    lens('clients', ['c1']),
    lens('comms'),
    lens('time'),
    lens('team', ['p1', 'a1']),
  ];

  it('maps each category to its primary focus lens', () => {
    const cases: Array<[MatterCategory, MatterLens['id']]> = [
      ['delivery', 'delivery'],
      ['people', 'people'],
      ['client', 'clients'],
      ['comms', 'comms'],
      ['time', 'time'],
      ['admin', 'team'],
    ];
    for (const [category, expected] of cases) {
      expect(relatedMatterLensId({ id: 'x', category }, lenses), category).toBe(expected);
    }
  });

  it('does not require itemIds to match (category is enough)', () => {
    expect(relatedMatterLensId({ id: 'missing', category: 'client' }, lenses)).toBe('clients');
  });

  it('returns null when nothing is selected', () => {
    expect(relatedMatterLensId(null, lenses)).toBeNull();
    expect(relatedMatterLensId(undefined, lenses)).toBeNull();
  });
});

describe('Matter related-focus highlight UI', () => {
  it('wires selected signal → highlightedLens without activating the filter', () => {
    const page = fs.readFileSync(pagePath, 'utf8');
    const lenses = fs.readFileSync(lensesPath, 'utf8');

    expect(page).toContain('relatedMatterLensId(selectedItem');
    expect(page).toContain('highlightedLens={relatedLensId}');
    expect(page).not.toContain('setActiveLens(relatedLensId');

    expect(lenses).toContain('highlightedLens');
    expect(lenses).toContain('matter-focus-lens-related');
    expect(lenses).toContain("data-highlighted={related ? 'true' : 'false'}");
  });

  it('uses a visible accent highlight instead of near-invisible accent-muted/10', () => {
    const lenses = fs.readFileSync(lensesPath, 'utf8');
    const css = fs.readFileSync(cssPath, 'utf8');

    expect(lenses).toContain('bg-accent/15');
    expect(lenses).not.toContain('bg-accent-muted/10');
    expect(css).toContain('.matter-focus-lens-related');
    expect(css).toContain('var(--color-accent)');
  });
});
