/**
 * Connector / source glyphs for Matter radar blips.
 * Brand marks from Simple Icons (https://simpleicons.org) — official brand paths.
 * Hub + fused use the York logo. Meeting uses Zoom blue + camera (Simple Icons
 * Zoom mark is a wordmark and is illegible at blip size).
 */

import type { ReactNode } from 'react';
import type { MatterSource } from '../../../shared/matter';
import yorkLogoSrc from '../../assets/logo.png';

/** Brand hex from Simple Icons / product guidelines. */
const BRAND = {
  slack: '#4A154B',
  gmail: '#EA4335',
  calendar: '#4285F4',
  jira: '#0052CC',
  drive: '#4285F4',
  zoom: '#2D8CFF',
  launchpad: '#0F766E',
  york: '#0B1F33',
} as const;

/** Fit a 24×24 Simple Icons path into the padded rounded tile. */
function BrandGlyph({ d, fill = '#fff' }: { d: string; fill?: string }) {
  return (
    <g transform="translate(5 5) scale(0.5833)" fill={fill}>
      <path d={d} />
    </g>
  );
}

function Tile({ fill, children }: { fill: string; children: ReactNode }) {
  return (
    <>
      <rect x="2" y="2" width="20" height="20" rx="5" fill={fill} />
      {children}
    </>
  );
}

// Official Simple Icons path data (viewBox 0 0 24 24)
const PATH = {
  slack:
    'M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z',
  gmail:
    'M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z',
  googlecalendar:
    'M18.316 5.684H24v12.632h-5.684V5.684zM5.684 24h12.632v-5.684H5.684V24zM18.316 5.684V0H1.895A1.894 1.894 0 0 0 0 1.895v16.421h5.684V5.684h12.632zm-7.207 6.25v-.065c.272-.144.5-.349.687-.617s.279-.595.279-.982c0-.379-.099-.72-.3-1.025a2.05 2.05 0 0 0-.832-.714 2.703 2.703 0 0 0-1.197-.257c-.6 0-1.094.156-1.481.467-.386.311-.65.671-.793 1.078l1.085.452c.086-.249.224-.461.413-.633.189-.172.445-.257.767-.257.33 0 .602.088.816.264a.86.86 0 0 1 .322.703c0 .33-.12.589-.36.778-.24.19-.535.284-.886.284h-.567v1.085h.633c.407 0 .748.109 1.02.327.272.218.407.499.407.843 0 .336-.129.614-.387.832s-.565.327-.924.327c-.351 0-.651-.103-.897-.311-.248-.208-.422-.502-.521-.881l-1.096.452c.178.616.505 1.082.977 1.401.472.319.984.478 1.538.477a2.84 2.84 0 0 0 1.293-.291c.382-.193.684-.458.902-.794.218-.336.327-.72.327-1.149 0-.429-.115-.797-.344-1.105a2.067 2.067 0 0 0-.881-.689zm2.093-1.931l.602.913L15 10.045v5.744h1.187V8.446h-.827l-2.158 1.557zM22.105 0h-3.289v5.184H24V1.895A1.894 1.894 0 0 0 22.105 0zm-3.289 23.5l4.684-4.684h-4.684V23.5zM0 22.105C0 23.152.848 24 1.895 24h3.289v-5.184H0v3.289z',
  jira: 'M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z',
  googledrive:
    'M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574zm-4.76 1.73a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.214zm2.259 12.653-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z',
} as const;

export function MatterSourceSymbolDefs() {
  return (
    <>
      <symbol id="matter-mark-slack" viewBox="0 0 24 24">
        <Tile fill={BRAND.slack}>
          <BrandGlyph d={PATH.slack} />
        </Tile>
      </symbol>

      <symbol id="matter-mark-gmail" viewBox="0 0 24 24">
        <Tile fill={BRAND.gmail}>
          <BrandGlyph d={PATH.gmail} />
        </Tile>
      </symbol>

      <symbol id="matter-mark-calendar" viewBox="0 0 24 24">
        <Tile fill={BRAND.calendar}>
          <BrandGlyph d={PATH.googlecalendar} />
        </Tile>
      </symbol>

      <symbol id="matter-mark-jira" viewBox="0 0 24 24">
        <Tile fill={BRAND.jira}>
          <BrandGlyph d={PATH.jira} />
        </Tile>
      </symbol>

      <symbol id="matter-mark-drive" viewBox="0 0 24 24">
        <Tile fill={BRAND.drive}>
          <BrandGlyph d={PATH.googledrive} />
        </Tile>
      </symbol>

      <symbol id="matter-mark-meeting" viewBox="0 0 24 24">
        <Tile fill={BRAND.zoom}>
          {/* Camera glyph — Zoom wordmark is illegible at blip size */}
          <path
            fill="#fff"
            d="M6.5 8.2h7.2a1.3 1.3 0 0 1 1.3 1.3v5a1.3 1.3 0 0 1-1.3 1.3H6.5A1.3 1.3 0 0 1 5.2 14.5v-5A1.3 1.3 0 0 1 6.5 8.2zm9.2 1.6 2.6-1.5a.7.7 0 0 1 1 .6v5.4a.7.7 0 0 1-1 .6l-2.6-1.5v-3.6z"
          />
        </Tile>
      </symbol>

      <symbol id="matter-mark-launchpad" viewBox="0 0 24 24">
        <Tile fill={BRAND.launchpad}>
          <path
            fill="#fff"
            d="M12.2 5.2c2.8 1.2 4.4 3.6 4.6 6.6.1 1.4-.2 2.7-.8 3.8l1.4 1.4-.9.9-1.4-1.4c-1.1.6-2.4.9-3.8.8-3-.2-5.4-1.8-6.6-4.6 2.2.4 4.4-.1 6-1.7 1.6-1.6 2.1-3.8 1.7-6zm-4.7 9.4c.7 1.2 1.8 2.1 3.1 2.5l-1.6 1.6c-.4-.5-.8-1-.9-1.6l-.6-2.5z"
          />
        </Tile>
      </symbol>

      <symbol id="matter-mark-hub" viewBox="0 0 24 24">
        <Tile fill={BRAND.york}>
          <image
            href={yorkLogoSrc}
            x="4"
            y="4"
            width="16"
            height="16"
            preserveAspectRatio="xMidYMid meet"
          />
        </Tile>
      </symbol>

      <symbol id="matter-mark-fused" viewBox="0 0 24 24">
        <Tile fill={BRAND.york}>
          <image
            href={yorkLogoSrc}
            x="5"
            y="5"
            width="14"
            height="14"
            preserveAspectRatio="xMidYMid meet"
          />
          <circle cx="18" cy="6" r="3.2" fill="#00b48a" />
        </Tile>
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
