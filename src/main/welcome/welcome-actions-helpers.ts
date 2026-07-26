/**
 * Pure helpers for welcome quick-action chips (no LLM / electron-store deps).
 */

import {
  DEFAULT_WELCOME_TAGLINE,
  isWelcomeActionIcon,
  type WelcomeConnectorSnapshot,
  type WelcomeQuickAction,
} from '../../shared/welcome-actions';
import {
  DEFAULT_HUB_MCP_NAME,
  DEFAULT_LAUNCHPAD_MCP_NAME,
  isGtmPulseMcpServer,
  isHubMcpServer,
  isLaunchpadMcpServer,
} from '../mcp/mcp-config-store';

const MAX_CHIPS = 6;
const MAX_LABEL_LEN = 28;

export function enrichChipsWithConnectorNames(
  chips: WelcomeQuickAction[],
  connectors: WelcomeConnectorSnapshot[]
): WelcomeQuickAction[] {
  const byId = new Map(connectors.map((c) => [c.id, c.name]));
  return chips.map((chip) => {
    const id = chip.requiresConnectorId?.trim() || null;
    if (!id) {
      return { ...chip, requiresConnectorId: null, requiresConnectorName: null };
    }
    return {
      ...chip,
      requiresConnectorId: id,
      requiresConnectorName: byId.get(id) ?? chip.requiresConnectorName ?? null,
    };
  });
}

export function getStaticFallbackChips(
  connectors: WelcomeConnectorSnapshot[]
): WelcomeQuickAction[] {
  const hub = connectors.find((c) => isHubMcpServer({ name: c.name, type: 'streamable-http' }));
  const launchpad = connectors.find((c) => isLaunchpadMcpServer({ name: c.name, type: 'stdio' }));
  const gtm = connectors.find((c) =>
    isGtmPulseMcpServer({ name: c.name, type: 'streamable-http' })
  );

  const chips: WelcomeQuickAction[] = [
    {
      id: 'draft-ic-memo',
      label: 'Draft IC memo',
      prompt:
        'Help me draft an investment committee memo. Ask for the company name and stage if missing, then outline thesis, market, team, traction, risks, and a clear recommendation.',
      icon: 'FileText',
    },
    {
      id: 'prep-diligence',
      label: 'Prep diligence notes',
      prompt:
        'Help me prepare a diligence checklist and note template for an active deal. Include product, GTM, financials, technical, and reference-check sections.',
      icon: 'ClipboardList',
    },
    {
      id: 'hub-timesheet',
      label: 'Log Hub timesheet',
      prompt:
        'Help me review and log my York IE Hub timesheet for this week. List drafts if available, suggest hours by project, and walk me through save/submit.',
      icon: 'Calendar',
      requiresConnectorId: hub?.id ?? null,
      requiresConnectorName: hub?.name ?? DEFAULT_HUB_MCP_NAME,
    },
    {
      id: 'launchpad-release',
      label: 'Check LaunchPad release',
      prompt:
        'Help me check the active R&D LaunchPad release: status, open work, and what to do next in the release loop.',
      icon: 'Rocket',
      requiresConnectorId: launchpad?.id ?? null,
      requiresConnectorName: launchpad?.name ?? DEFAULT_LAUNCHPAD_MCP_NAME,
    },
    {
      id: 'gtm-pipeline',
      label: 'GTM pipeline snapshot',
      prompt:
        'Give me a concise GTM Pulse pipeline snapshot: key deals, next actions, and anything at risk this week.',
      icon: 'Target',
      requiresConnectorId: gtm?.id ?? null,
      requiresConnectorName: gtm?.name ?? 'GTM Pulse',
    },
    {
      id: 'client-deck',
      label: 'Build client deck',
      prompt:
        'Help me create a short client update deck (PPTX). Ask for audience and goal if needed, then outline slides and generate the presentation.',
      icon: 'Presentation',
    },
  ];

  return enrichChipsWithConnectorNames(chips, connectors).slice(0, MAX_CHIPS);
}

function sanitizeId(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  return (
    raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || fallback
  );
}

function sanitizeLabel(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  return raw.trim().replace(/\s+/g, ' ').slice(0, MAX_LABEL_LEN);
}

function sanitizePrompt(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  return raw.trim().slice(0, 2000);
}

/**
 * Validate and normalize LLM (or any) chip JSON into WelcomeQuickAction[].
 */
export function parseAndValidateWelcomeChips(
  raw: unknown,
  connectors: WelcomeConnectorSnapshot[]
): WelcomeQuickAction[] {
  if (!Array.isArray(raw)) return [];
  const knownIds = new Set(connectors.map((c) => c.id));
  const seen = new Set<string>();
  const chips: WelcomeQuickAction[] = [];

  for (let i = 0; i < raw.length && chips.length < MAX_CHIPS; i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const id = sanitizeId(rec.id, `action-${i + 1}`);
    if (seen.has(id)) continue;
    seen.add(id);

    const icon = isWelcomeActionIcon(rec.icon) ? rec.icon : 'FileText';
    let requiresConnectorId: string | null = null;
    if (typeof rec.requiresConnectorId === 'string' && rec.requiresConnectorId.trim()) {
      const cid = rec.requiresConnectorId.trim();
      if (knownIds.has(cid)) requiresConnectorId = cid;
    }

    const label = sanitizeLabel(rec.label, 'Quick action');
    const prompt = sanitizePrompt(rec.prompt, label);
    if (!prompt) continue;

    chips.push({
      id,
      label,
      prompt,
      icon,
      requiresConnectorId,
    });
  }

  return enrichChipsWithConnectorNames(chips, connectors);
}

export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

export function extractJsonValue(text: string): unknown {
  const cleaned = stripCodeFences(text);
  try {
    return JSON.parse(cleaned) as unknown;
  } catch {
    const objStart = cleaned.indexOf('{');
    const objEnd = cleaned.lastIndexOf('}');
    const arrStart = cleaned.indexOf('[');
    const arrEnd = cleaned.lastIndexOf(']');

    const preferObject =
      objStart >= 0 &&
      objEnd > objStart &&
      (arrStart < 0 || objStart < arrStart || (arrEnd <= arrStart && objEnd > objStart));

    if (preferObject) {
      try {
        return JSON.parse(cleaned.slice(objStart, objEnd + 1)) as unknown;
      } catch {
        // fall through to array
      }
    }
    if (arrStart >= 0 && arrEnd > arrStart) {
      return JSON.parse(cleaned.slice(arrStart, arrEnd + 1)) as unknown;
    }
    throw new Error('No JSON found');
  }
}

/** @deprecated Prefer extractJsonValue — kept for callers expecting arrays. */
export function extractJsonArray(text: string): unknown {
  return extractJsonValue(text);
}

const MAX_TAGLINE_LEN = 90;

export function sanitizeWelcomeTagline(
  raw: unknown,
  fallback: string = DEFAULT_WELCOME_TAGLINE
): string {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  const cleaned = raw
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, MAX_TAGLINE_LEN);
  return cleaned.length >= 12 ? cleaned : fallback;
}

export interface ParsedWelcomePayload {
  chips: WelcomeQuickAction[];
  tagline: string;
}

/**
 * Parse LLM output that is either `{ tagline, chips }` or a bare chips array.
 */
export function parseWelcomeGenerationPayload(
  raw: unknown,
  connectors: WelcomeConnectorSnapshot[],
  fallbackTagline: string = DEFAULT_WELCOME_TAGLINE
): ParsedWelcomePayload {
  if (Array.isArray(raw)) {
    return {
      chips: parseAndValidateWelcomeChips(raw, connectors),
      tagline: fallbackTagline,
    };
  }
  if (raw && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>;
    const chipsRaw = Array.isArray(rec.chips)
      ? rec.chips
      : Array.isArray(rec.actions)
        ? rec.actions
        : Array.isArray(rec.quickActions)
          ? rec.quickActions
          : null;
    return {
      chips: chipsRaw ? parseAndValidateWelcomeChips(chipsRaw, connectors) : [],
      tagline: sanitizeWelcomeTagline(rec.tagline ?? rec.title ?? rec.subtitle, fallbackTagline),
    };
  }
  return { chips: [], tagline: fallbackTagline };
}
