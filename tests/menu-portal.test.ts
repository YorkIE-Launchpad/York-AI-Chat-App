/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Menu } from '../src/renderer/components/ui/Menu';

afterEach(() => {
  cleanup();
});

describe('Menu portal', () => {
  it('renders the dropdown on document.body so overflow ancestors cannot cover it', () => {
    const onSelect = vi.fn();
    render(
      createElement(
        'div',
        {
          'data-testid': 'clip',
          style: { overflow: 'hidden', width: 48, height: 48, position: 'relative' },
        },
        createElement(Menu, {
          align: 'left',
          side: 'top',
          items: [
            { id: 'incognito', label: 'Incognito task', onSelect },
            { id: 'import', label: 'Import chat', onSelect: () => {} },
            { id: 'join', label: 'Join shared chat', onSelect: () => {} },
          ],
          trigger: ({ toggle, open }) =>
            createElement(
              'button',
              {
                type: 'button',
                'aria-label': 'More options',
                'aria-expanded': open,
                onClick: toggle,
              },
              'More'
            ),
        })
      )
    );

    fireEvent.click(screen.getByRole('button', { name: 'More options' }));

    const menu = screen.getByRole('menu');
    const clip = screen.getByTestId('clip');
    expect(clip.contains(menu)).toBe(false);
    expect(document.body.contains(menu)).toBe(true);
    expect(menu.className).toContain('fixed');
    expect(menu.className).toContain('z-[80]');
    expect(menu.textContent).toContain('Incognito task');
    expect(menu.textContent).toContain('Import chat');
    expect(menu.textContent).toContain('Join shared chat');

    fireEvent.click(screen.getByRole('menuitem', { name: 'Incognito task' }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
