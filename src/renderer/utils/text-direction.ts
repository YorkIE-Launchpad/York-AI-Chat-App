// Let the browser choose the direction from the first strong character in each
// text block. `plaintext` keeps embedded LTR/RTL runs isolated from surrounding UI.
export const AUTO_TEXT_DIRECTION_PROPS = {
  dir: 'auto',
  style: { unicodeBidi: 'plaintext' },
} as const;
