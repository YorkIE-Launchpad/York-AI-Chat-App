/**
 * Connector / source glyphs for Matter radar blips.
 * Inline SVG marks (no extra icon package). Hub + fused use the York logo.
 */

import type { MatterSource } from '../../../shared/matter';
import yorkLogoSrc from '../../assets/logo.png';

export function MatterSourceSymbolDefs() {
  return (
    <>
      <symbol id="matter-mark-slack" viewBox="0 0 24 24">
        <rect x="2" y="2" width="20" height="20" rx="5" fill="#4A154B" />
        <path
          fill="#fff"
          d="M8.5 13.6a1.4 1.4 0 1 1-1.4-1.4h1.4v1.4zm.7 0a1.4 1.4 0 1 1 2.8 0v3.5a1.4 1.4 0 1 1-2.8 0v-3.5zm1.4-5.1a1.4 1.4 0 1 1 1.4-1.4v1.4h-1.4zm0 .7a1.4 1.4 0 1 1 0 2.8H5.1a1.4 1.4 0 1 1 0-2.8h5.5zm5.1 1.4a1.4 1.4 0 1 1 1.4 1.4h-1.4v-1.4zm-.7 0a1.4 1.4 0 1 1-2.8 0V5.1a1.4 1.4 0 1 1 2.8 0v5.5zm-1.4 5.1a1.4 1.4 0 1 1-1.4 1.4v-1.4h1.4zm0-.7a1.4 1.4 0 1 1 0-2.8h5.5a1.4 1.4 0 1 1 0 2.8h-5.5z"
        />
      </symbol>

      <symbol id="matter-mark-gmail" viewBox="0 0 24 24">
        <rect x="2" y="2" width="20" height="20" rx="5" fill="#fff" />
        <path fill="#EA4335" d="M4.5 6.2v11.6l4.2-3.15V9.8L4.5 6.2z" />
        <path fill="#34A853" d="M19.5 6.2v11.6l-4.2-3.15V9.8l4.2-3.6z" />
        <path fill="#FBBC05" d="M4.5 17.8l4.2-3.15 3.3 2.48 3.3-2.48 4.2 3.15H4.5z" />
        <path fill="#C5221F" d="M12 12.8L4.5 6.2h15L12 12.8z" />
        <path fill="#4285F4" d="M8.7 14.65V9.8l3.3 2.95 3.3-2.95v4.85l-3.3 2.48-3.3-2.48z" />
      </symbol>

      <symbol id="matter-mark-calendar" viewBox="0 0 24 24">
        <rect x="2" y="2" width="20" height="20" rx="5" fill="#fff" />
        <path fill="#1A73E8" d="M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v3H3.5V6A1.5 1.5 0 0 1 5 4.5z" />
        <path fill="#EA4335" d="M3.5 9h17v9.5A1.5 1.5 0 0 1 19 20H5a1.5 1.5 0 0 1-1.5-1.5V9z" />
        <path
          fill="#fff"
          d="M8 12.2h2.2v2.2H8zm3.4 0H13.6v2.2h-2.2zm3.4 0H17v2.2h-2.2zM8 15.6h2.2V17.8H8zm3.4 0H13.6v2.2h-2.2z"
        />
      </symbol>

      <symbol id="matter-mark-jira" viewBox="0 0 24 24">
        <rect x="2" y="2" width="20" height="20" rx="5" fill="#2684FF" />
        <path
          fill="#fff"
          d="M12 5.2 7.4 12 12 18.8 16.6 12 12 5.2zm0 3.4 2.4 3.4-2.4 3.4-2.4-3.4 2.4-3.4z"
        />
      </symbol>

      <symbol id="matter-mark-drive" viewBox="0 0 24 24">
        <rect x="2" y="2" width="20" height="20" rx="5" fill="#fff" />
        <path fill="#4285F4" d="M8.6 16.8h9.8l-3.1-5.4H5.5l3.1 5.4z" />
        <path fill="#EA4335" d="M15.3 6.2H8.7L5.5 11.4h6.6l3.2-5.2z" />
        <path fill="#FBBC05" d="M18.4 16.8 15.3 6.2l-3.2 5.2 3.1 5.4h3.2z" />
        <path fill="#34A853" d="M5.5 11.4 8.6 16.8H5.5l-2-3.5 2-1.9z" />
      </symbol>

      <symbol id="matter-mark-meeting" viewBox="0 0 24 24">
        <rect x="2" y="2" width="20" height="20" rx="5" fill="#0B5CFF" />
        <path
          fill="#fff"
          d="M6.5 8.2h7.2a1.3 1.3 0 0 1 1.3 1.3v5a1.3 1.3 0 0 1-1.3 1.3H6.5A1.3 1.3 0 0 1 5.2 14.5v-5A1.3 1.3 0 0 1 6.5 8.2zm9.2 1.6 2.6-1.5a.7.7 0 0 1 1 .6v5.4a.7.7 0 0 1-1 .6l-2.6-1.5v-3.6z"
        />
      </symbol>

      <symbol id="matter-mark-launchpad" viewBox="0 0 24 24">
        <rect x="2" y="2" width="20" height="20" rx="5" fill="#0F766E" />
        <path
          fill="#fff"
          d="M12.2 5.2c2.8 1.2 4.4 3.6 4.6 6.6.1 1.4-.2 2.7-.8 3.8l1.4 1.4-.9.9-1.4-1.4c-1.1.6-2.4.9-3.8.8-3-.2-5.4-1.8-6.6-4.6 2.2.4 4.4-.1 6-1.7 1.6-1.6 2.1-3.8 1.7-6zm-4.7 9.4c.7 1.2 1.8 2.1 3.1 2.5l-1.6 1.6c-.4-.5-.8-1-.9-1.6l-.6-2.5z"
        />
      </symbol>

      <symbol id="matter-mark-hub" viewBox="0 0 24 24">
        <rect x="2" y="2" width="20" height="20" rx="5" fill="#0B1F33" />
        <image
          href={yorkLogoSrc}
          x="4"
          y="4"
          width="16"
          height="16"
          preserveAspectRatio="xMidYMid meet"
        />
      </symbol>

      <symbol id="matter-mark-fused" viewBox="0 0 24 24">
        <rect x="2" y="2" width="20" height="20" rx="5" fill="#0B1F33" />
        <image
          href={yorkLogoSrc}
          x="5"
          y="5"
          width="14"
          height="14"
          preserveAspectRatio="xMidYMid meet"
        />
        <circle cx="18" cy="6" r="3.2" fill="#00b48a" />
      </symbol>
    </>
  );
}

export function matterSourceSymbolId(source: MatterSource): string {
  switch (source) {
    case 'slack':
      return 'matter-mark-slack';
    case 'gmail':
      return 'matter-mark-gmail';
    case 'calendar':
      return 'matter-mark-calendar';
    case 'jira':
      return 'matter-mark-jira';
    case 'drive':
      return 'matter-mark-drive';
    case 'meeting':
      return 'matter-mark-meeting';
    case 'launchpad':
      return 'matter-mark-launchpad';
    case 'fused':
      return 'matter-mark-fused';
    case 'hub':
    default:
      return 'matter-mark-hub';
  }
}

export function MatterSourceBlipMark({
  source,
  x,
  y,
  size,
  opacity = 1,
}: {
  source: MatterSource;
  x: number;
  y: number;
  size: number;
  opacity?: number;
}) {
  const half = size / 2;
  return (
    <use
      href={`#${matterSourceSymbolId(source)}`}
      x={x - half}
      y={y - half}
      width={size}
      height={size}
      opacity={opacity}
    />
  );
}
