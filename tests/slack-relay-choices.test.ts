import { describe, expect, it } from 'vitest';
import {
  buildModelChoices,
  buildWorkspaceChoices,
  describeModel,
  matchChoices,
  modelSelectionConfig,
  workspaceKey,
} from '../src/main/remote/channels/slack/slack-relay-choices';
import { parseSlackTextCommand } from '../src/main/remote/channels/slack/slack-relay-format';
import { BACKEND_PROXY_PLACEHOLDER_KEY } from '../src/shared/backend-config';

const MODELS = [
  { id: 'anthropic/claude-sonnet', name: 'Claude Sonnet', provider: 'anthropic' as const },
  { id: 'openai/gpt-5', name: 'openai/gpt-5', provider: 'openai' as const },
  { id: 'gpt-image-2.5', name: 'GPT Image', provider: 'openai' as const },
  { id: 'gemini-pro', name: 'Gemini Pro', provider: 'gemini' as const, hasBudget: false },
];

describe('model choices', () => {
  it('offers Auto plus chat models with budget', () => {
    expect(buildModelChoices(MODELS).map((c) => [c.label, c.detail])).toEqual([
      ['Auto', 'Picks a model for each message'],
      ['York LLM V1', 'Free shared server'],
      ['Claude Sonnet', 'Anthropic'],
      ['gpt-5', 'OpenAI'],
    ]);
  });

  it('describes the configured model', () => {
    expect(describeModel('auto', MODELS)).toBe('Auto');
    expect(describeModel('york-llm', MODELS)).toBe('York LLM V1');
    expect(describeModel('anthropic/claude-sonnet', MODELS)).toBe('Claude Sonnet');
    expect(describeModel('custom-local', MODELS)).toBe('custom-local');
    expect(describeModel(undefined, MODELS)).toBe('Not set');
  });

  it('builds the same config as the desktop model picker', () => {
    expect(modelSelectionConfig(MODELS[0])).toMatchObject({
      provider: 'anthropic',
      activeProfileKey: 'anthropic',
      customProtocol: 'anthropic',
      model: 'anthropic/claude-sonnet',
      apiKey: BACKEND_PROXY_PLACEHOLDER_KEY,
    });
  });
});

describe('workspace choices', () => {
  const projects = [
    {
      canonicalKey: 'hub:2',
      name: 'Zeta Rebrand',
      sources: { hub: true as const },
      hubProjectId: '2',
      clientName: 'Zeta',
    },
    {
      canonicalKey: 'lp:1',
      name: 'Acme App',
      sources: { launchpad: true as const },
      launchpadProjectId: 1,
    },
  ];
  const folders = [
    { id: 'old', name: 'Old notes', createdAt: 1, updatedAt: 1 },
    { id: 'new', name: 'Launch plan', createdAt: 1, updatedAt: 5 },
  ];

  it('lists General, Hub, folders (newest first), projects, then clients', () => {
    const choices = buildWorkspaceChoices(folders, projects);
    expect(choices.map((c) => c.key)).toEqual([
      'general',
      'hub',
      'folder:new',
      'folder:old',
      'project:lp:1',
      'project:hub:2',
      expect.stringMatching(/^client:/),
    ]);
    expect(choices[5].detail).toBe('Project · Zeta');
    expect(workspaceKey(null)).toBe('general');
  });

  it('matches exact names first, then every typed word', () => {
    const choices = buildWorkspaceChoices(folders, projects);
    expect(matchChoices(choices, 'hub').map((c) => c.label)).toEqual(['Hub']);
    expect(matchChoices(choices, 'zeta').map((c) => c.label)).toEqual(['Zeta']);
    expect(matchChoices(choices, 'zeta rebrand').map((c) => c.label)).toEqual(['Zeta Rebrand']);
    expect(matchChoices(choices, 'launch').map((c) => c.label)).toEqual(['Launch plan']);
    expect(matchChoices(choices, 'personal folder').map((c) => c.label)).toEqual([
      'Launch plan',
      'Old notes',
    ]);
    expect(matchChoices(choices, 'nothing')).toEqual([]);
  });
});

describe('typed model / workspace commands', () => {
  it('parses names after /growthos model and /growthos workspace', () => {
    expect(parseSlackTextCommand('/growthos model opus')).toEqual({ name: 'model', arg: 'opus' });
    expect(parseSlackTextCommand('/growthos models')).toEqual({ name: 'model' });
    expect(parseSlackTextCommand('/growthos ws Acme App')).toEqual({
      name: 'workspace',
      arg: 'Acme App',
    });
    expect(parseSlackTextCommand('/growthos chats extra')).toEqual({ name: 'chats' });
  });
});
