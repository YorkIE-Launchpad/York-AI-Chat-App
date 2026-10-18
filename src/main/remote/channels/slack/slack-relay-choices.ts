/**
 * Model and workspace choices for `/growthos model` and `/growthos workspace`:
 * built from the same catalogs as the desktop pickers, and matched by typed name.
 */
import { AUTO_MODEL_ID, isAutoModelId } from '../../../../shared/auto-model';
import {
  BACKEND_PROXY_PLACEHOLDER_KEY,
  applyBackendManagedCredentials,
  type BackendCloudProvider,
  type BackendModelInfo,
} from '../../../../shared/backend-config';
import { isGptImage25ModelId } from '../../../../shared/image-generation';
import {
  groupUnifiedProjectsByClient,
  type UnifiedCompanyProject,
} from '../../../../shared/unified-company-projects';
import {
  activeDivisionFromUnifiedProject,
  clientDivisionFromProjects,
  divisionLabel,
  type ActiveDivision,
  type PersonalFolder,
} from '../../../../shared/workspace-division';
import { YORK_LLM_DISPLAY_NAME, YORK_LLM_SLACK_MODEL_ID } from '../../../../shared/york-llm-config';

export interface SlackRelayChoice<T> {
  key: string;
  label: string;
  detail: string;
  value: T;
}

const PROVIDER_LABELS: Record<BackendCloudProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini',
};

function modelLabel(model: BackendModelInfo): string {
  if (model.name && model.name !== model.id) return model.name;
  return model.id.split('/').pop() || model.id;
}

/** Chat models the user can switch to now: Auto, then catalog models with budget. */
export function buildModelChoices(models: BackendModelInfo[]): SlackRelayChoice<string>[] {
  const choices: SlackRelayChoice<string>[] = [
    {
      key: AUTO_MODEL_ID,
      label: 'Auto',
      detail: 'Picks a model for each message',
      value: AUTO_MODEL_ID,
    },
    {
      key: YORK_LLM_SLACK_MODEL_ID,
      label: YORK_LLM_DISPLAY_NAME,
      detail: 'Free shared server',
      value: YORK_LLM_SLACK_MODEL_ID,
    },
  ];
  for (const model of models) {
    if (isGptImage25ModelId(model.id) || model.hasBudget === false) continue;
    choices.push({
      key: model.id,
      label: modelLabel(model),
      detail: PROVIDER_LABELS[model.provider] ?? model.provider,
      value: model.id,
    });
  }
  return choices;
}

/** Config change for picking a catalog model; same as the desktop model selector. */
export function modelSelectionConfig(model: BackendModelInfo) {
  return applyBackendManagedCredentials({
    provider: model.provider,
    activeProfileKey: model.provider,
    customProtocol: model.provider,
    model: model.id,
    apiKey: BACKEND_PROXY_PLACEHOLDER_KEY,
  });
}

/** Picker key for the active model, mapping a York LLM selection onto the York option. */
export function slackCurrentModelKey(
  modelId: string | undefined,
  label?: string
): string | undefined {
  if (label === YORK_LLM_DISPLAY_NAME || modelId === YORK_LLM_SLACK_MODEL_ID) {
    return YORK_LLM_SLACK_MODEL_ID;
  }
  return modelId;
}

/** Display name for the configured model id, even when it is not in the catalog. */
export function describeModel(modelId: string | undefined, models: BackendModelInfo[]): string {
  if (!modelId) return 'Not set';
  if (isAutoModelId(modelId)) return 'Auto';
  if (modelId === YORK_LLM_SLACK_MODEL_ID) return YORK_LLM_DISPLAY_NAME;
  const model = models.find((m) => m.id === modelId);
  return model ? modelLabel(model) : modelId;
}

export function workspaceKey(division: ActiveDivision | null): string {
  if (!division || division.kind === 'general') return 'general';
  if (division.kind === 'hub') return 'hub';
  if (division.kind === 'folder') return `folder:${division.folderId}`;
  return `${division.kind}:${division.canonicalKey}`;
}

export function describeWorkspace(division: ActiveDivision | null): string {
  return division ? divisionLabel(division) : 'General';
}

/** Every workspace the desktop picker offers, in its order. */
export function buildWorkspaceChoices(
  folders: PersonalFolder[],
  projects: UnifiedCompanyProject[]
): SlackRelayChoice<ActiveDivision>[] {
  const choice = (value: ActiveDivision, detail: string): SlackRelayChoice<ActiveDivision> => ({
    key: workspaceKey(value),
    label: divisionLabel(value),
    detail,
    value,
  });
  const choices = [
    choice({ kind: 'general' }, 'Everyday chats'),
    choice({ kind: 'hub' }, 'York IE Hub'),
  ];
  for (const folder of [...folders].sort((a, b) => b.updatedAt - a.updatedAt)) {
    choices.push(
      choice({ kind: 'folder', folderId: folder.id, folderName: folder.name }, 'Personal folder')
    );
  }
  const sorted = [...projects].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
  );
  for (const project of sorted) {
    const client = project.clientName?.trim();
    choices.push(
      choice(activeDivisionFromUnifiedProject(project), client ? `Project · ${client}` : 'Project')
    );
  }
  for (const group of groupUnifiedProjectsByClient(projects)) {
    const count = group.projects.length;
    choices.push(
      choice(
        clientDivisionFromProjects(group.clientName, group.projects),
        `Client · ${count} project${count === 1 ? '' : 's'}`
      )
    );
  }
  return choices;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Choices matching a typed name: an exact label or key wins outright; otherwise
 * every word of the query must appear in the label or detail.
 */
export function matchChoices<T>(
  choices: SlackRelayChoice<T>[],
  query: string
): SlackRelayChoice<T>[] {
  const q = normalize(query);
  if (!q) return choices;
  const exact = choices.filter((c) => normalize(c.label) === q || normalize(c.key) === q);
  if (exact.length > 0) return exact;
  const words = q.split(' ');
  return choices.filter((c) => {
    const haystack = ` ${normalize(`${c.label} ${c.key} ${c.detail}`)} `;
    return words.every((word) => haystack.includes(word));
  });
}
