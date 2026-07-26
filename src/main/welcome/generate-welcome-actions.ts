/**
 * Generate / cache / fall back welcome quick-action chips via OpenRouter free model.
 */

import type { AppConfig } from '../config/config-store';
import { resolveFreeModelForChild } from '../agent/free-model-resolve';
import { runPiAiOneShot } from '../agent/sdk-one-shot';
import { log, logWarn } from '../utils/logger';
import {
  buildConnectorFingerprint,
  formatWelcomeProfileSummary,
  isWelcomeActionIcon,
  type WelcomeActionsSource,
  type WelcomeConnectorSnapshot,
  type WelcomeProfile,
  type WelcomeQuickAction,
  type WelcomeQuickActionsResponse,
} from '../../shared/welcome-actions';
import {
  DEFAULT_HUB_MCP_NAME,
  DEFAULT_LAUNCHPAD_MCP_NAME,
  isGtmPulseMcpServer,
  isHubMcpServer,
  isLaunchpadMcpServer,
} from '../mcp/mcp-config-store';
import { welcomeActionsStore } from './welcome-actions-store';

const MAX_CHIPS = 6;
const MAX_LABEL_LEN = 28;

const SYSTEM_PROMPT = `You generate welcome quick-action chips for York IE VECOS, an internal AI desktop app for York IE (investment + consultancy).

Return ONLY a JSON array of 5 or 6 objects. No markdown fences, no commentary.
Each object:
{
  "id": "kebab-case-id",
  "label": "short label <= 28 chars",
  "prompt": "full actionable user message the assistant should receive",
  "icon": one of FileText|BarChart3|FolderOpen|Mail|BookOpen|FileSearch|Users|Briefcase|Rocket|Calendar|ClipboardList|Target|Presentation|Search,
  "requiresConnectorId": "<mcp server id from the connector list, or null>"
}

Rules:
- Tailor actions to the user's title / function / squad when provided.
- Prefer actions that use ENABLED connectors; set requiresConnectorId only to an id from the provided list.
- Do not invent connectors that are not listed.
- Cover York IE domains where relevant: Hub (timesheets, leave, people), LaunchPad (releases/SDLC), GTM Pulse, deal flow / diligence / portfolio memos, client decks (pptx/docx/xlsx/pdf).
- Prompts must be concrete and ready to run (not placeholders like [topic]).
- Labels should be title-case short phrases.`;

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

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function extractJsonArray(text: string): unknown {
  const cleaned = stripCodeFences(text);
  try {
    return JSON.parse(cleaned) as unknown;
  } catch {
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    }
    throw new Error('No JSON array found');
  }
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

function buildUserPrompt(
  profile: WelcomeProfile | null,
  connectors: WelcomeConnectorSnapshot[]
): string {
  const profileBlock = profile
    ? JSON.stringify(
        {
          name: profile.name,
          email: profile.email,
          title: profile.title,
          function: profile.functionName,
          squad: profile.squad,
          department: profile.department,
        },
        null,
        2
      )
    : '{"note":"No Hub profile available; use general York IE employee defaults."}';

  const connectorBlock = JSON.stringify(
    connectors.map((c) => ({
      id: c.id,
      name: c.name,
      enabled: c.enabled,
      status: c.status,
      toolCount: c.toolCount,
    })),
    null,
    2
  );

  return `User profile:\n${profileBlock}\n\nMCP connectors:\n${connectorBlock}\n\nGenerate the JSON array now.`;
}

async function generateChipsWithLlm(
  profile: WelcomeProfile | null,
  connectors: WelcomeConnectorSnapshot[],
  config: AppConfig
): Promise<WelcomeQuickAction[] | null> {
  try {
    const userPrompt = buildUserPrompt(profile, connectors);
    const free = await resolveFreeModelForChild({
      promptText: userPrompt,
      parent: {
        model: config.model,
        provider: config.provider,
        customProtocol: config.customProtocol,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        autoModelPreference: config.autoModelPreference,
      },
    });

    const oneShotConfig: AppConfig = {
      ...config,
      model: free.modelId,
      provider: free.provider as AppConfig['provider'],
      customProtocol: free.customProtocol,
      baseUrl: free.baseUrl || config.baseUrl,
      apiKey: free.apiKey || config.apiKey,
    };

    const result = await runPiAiOneShot(userPrompt, SYSTEM_PROMPT, oneShotConfig, {
      temperature: 0.4,
      maxTokens: 1200,
    });

    const parsed = extractJsonArray(result.text);
    const chips = parseAndValidateWelcomeChips(parsed, connectors);
    if (chips.length < 3) {
      logWarn('[WelcomeActions] LLM returned too few valid chips:', chips.length);
      return null;
    }
    log(`[WelcomeActions] Generated ${chips.length} chips via ${free.strategy}/${free.modelId}`);
    return chips;
  } catch (error) {
    logWarn('[WelcomeActions] LLM generation failed:', error);
    return null;
  }
}

export interface GetWelcomeQuickActionsOptions {
  profile: WelcomeProfile | null;
  connectors: WelcomeConnectorSnapshot[];
  config: AppConfig;
  forceRegenerate?: boolean;
}

/**
 * Return cached chips when fingerprint matches; otherwise generate (or fall back).
 */
export async function getWelcomeQuickActions(
  options: GetWelcomeQuickActionsOptions
): Promise<WelcomeQuickActionsResponse> {
  const { profile, connectors, config, forceRegenerate } = options;
  const fingerprint = buildConnectorFingerprint(connectors);
  const email = profile?.email?.trim().toLowerCase() || '';

  if (!forceRegenerate && email) {
    const cached = welcomeActionsStore.get(email);
    if (cached && cached.connectorFingerprint === fingerprint && cached.chips?.length) {
      return {
        chips: enrichChipsWithConnectorNames(cached.chips, connectors),
        source: 'cache',
        profileSummary: formatWelcomeProfileSummary(cached.profile || profile!),
        connectorFingerprint: fingerprint,
      };
    }
  }

  let chips = await generateChipsWithLlm(profile, connectors, config);
  let source: WelcomeActionsSource = 'generated';

  if (!chips || chips.length === 0) {
    chips = getStaticFallbackChips(connectors);
    source = 'fallback';
  }

  if (email) {
    welcomeActionsStore.set({
      email,
      connectorFingerprint: fingerprint,
      chips,
      profile,
      updatedAt: Date.now(),
    });
  }

  return {
    chips,
    source,
    profileSummary: profile ? formatWelcomeProfileSummary(profile) : null,
    connectorFingerprint: fingerprint,
  };
}
