import { describe, expect, it } from 'vitest';
import {
  LaunchPadTurnProgress,
  isLaunchPadPollToolForLoopGuard,
  isNonTerminalJobResult,
  isTerminalJobResult,
  normalizeLaunchPadToolBaseName,
  userAskedForPreviewSurface,
  userExplicitlyAskedForBackend,
} from '../src/main/agent/launchpad-turn-progress';

describe('normalizeLaunchPadToolBaseName', () => {
  it('strips mcp__server__ prefix', () => {
    expect(normalizeLaunchPadToolBaseName('mcp__R_D_Launchpad__start_scope_implement')).toBe(
      'start_scope_implement'
    );
  });

  it('lowercases bare names', () => {
    expect(normalizeLaunchPadToolBaseName('Start_Preview')).toBe('start_preview');
  });
});

describe('user surface intent', () => {
  it('detects preview surface without backend intent', () => {
    const p = 'Implement NFL games with FC4 format on preview. Show all the team logos on the card';
    expect(userAskedForPreviewSurface(p)).toBe(true);
    expect(userExplicitlyAskedForBackend(p)).toBe(false);
  });

  it('detects explicit backend / development intent', () => {
    expect(userExplicitlyAskedForBackend('fix the bug in the development repo')).toBe(true);
    expect(userExplicitlyAskedForBackend('use Backend Code chat for this')).toBe(true);
    expect(userExplicitlyAskedForBackend('implement on preview')).toBe(false);
  });
});

describe('terminal heuristics', () => {
  it('flags in-progress status', () => {
    expect(isNonTerminalJobResult('status: running')).toBe(true);
    expect(isNonTerminalJobResult('agentActive: true, locked: false')).toBe(true);
    expect(isNonTerminalJobResult('done: 1 of 4')).toBe(true);
  });

  it('flags terminal status', () => {
    expect(isTerminalJobResult('status: completed')).toBe(true);
    expect(isTerminalJobResult('locked: true, agentActive: false')).toBe(true);
    expect(isTerminalJobResult('done: 4 of 4')).toBe(true);
    expect(isNonTerminalJobResult('readyForNextCycle: true')).toBe(false);
  });
});

describe('LaunchPadTurnProgress.snapshot', () => {
  const previewPrompt =
    'Implement NFL games with FC4 format on preview. Show all the team logos on the card';

  it('flags development implement when user asked for preview', () => {
    const p = new LaunchPadTurnProgress();
    p.record({
      toolName: 'mcp__Launchpad__start_scope_implement',
      args: { target: 'development', execution: 'sequential' },
      resultText: 'started',
    });
    const snap = p.snapshot(previewPrompt);
    expect(snap.hasWrongImplementTarget).toBe(true);
  });

  it('flags backend_code_chat when user asked for preview', () => {
    const p = new LaunchPadTurnProgress();
    p.record({
      toolName: 'backend_code_chat_send_message',
      args: { prompt: 'add logos' },
      resultText: 'session active',
    });
    const snap = p.snapshot(previewPrompt);
    expect(snap.hasWrongImplementTarget).toBe(true);
  });

  it('does not flag platform implement as wrong target', () => {
    const p = new LaunchPadTurnProgress();
    p.record({
      toolName: 'start_scope_implement',
      args: { target: 'platform' },
      resultText: 'run started',
    });
    const snap = p.snapshot(previewPrompt);
    expect(snap.hasWrongImplementTarget).toBe(false);
    expect(snap.asyncJobsInProgress).toContain('start_scope_implement');
  });

  it('clears async when poll is terminal', () => {
    const p = new LaunchPadTurnProgress();
    p.record({
      toolName: 'start_scope_implement',
      args: { target: 'platform' },
      resultText: 'started',
    });
    p.record({
      toolName: 'get_scope_implement_active',
      args: {},
      resultText: JSON.stringify({ status: 'completed', done: 2, total: 2 }),
    });
    const snap = p.snapshot(previewPrompt);
    expect(snap.asyncJobsInProgress).not.toContain('start_scope_implement');
    expect(snap.lastImplementTerminal).toBe(true);
  });

  it('needs start_preview after platform implement when user asked for preview', () => {
    const p = new LaunchPadTurnProgress();
    p.record({
      toolName: 'start_scope_implement',
      args: { target: 'platform' },
      resultText: 'started',
    });
    p.record({
      toolName: 'get_scope_implement_run',
      args: {},
      resultText: 'status: completed',
    });
    const snap = p.snapshot(previewPrompt);
    expect(snap.needsPreviewAfterImplement).toBe(true);
  });

  it('does not need preview after start_preview already ran', () => {
    const p = new LaunchPadTurnProgress();
    p.record({
      toolName: 'start_scope_implement',
      args: { target: 'platform' },
      resultText: 'started',
    });
    p.record({
      toolName: 'get_scope_implement_active',
      args: {},
      resultText: 'status: completed',
    });
    p.record({
      toolName: 'start_preview',
      args: {},
      resultText: 'preview started',
    });
    p.record({
      toolName: 'get_preview_status',
      args: {},
      resultText: 'status: ready',
    });
    const snap = p.snapshot(previewPrompt);
    expect(snap.needsPreviewAfterImplement).toBe(false);
  });

  it('skips wait for development start when wrong target (preview ask)', () => {
    const p = new LaunchPadTurnProgress();
    p.record({
      toolName: 'start_scope_implement',
      args: { target: 'development' },
      resultText: 'started',
    });
    const snap = p.snapshot(previewPrompt);
    expect(snap.hasWrongImplementTarget).toBe(true);
    // wrong-target starts are not tracked as async wait
    expect(snap.asyncJobsInProgress).not.toContain('start_scope_implement');
  });

  it('allows development implement when user asked for development repo', () => {
    const p = new LaunchPadTurnProgress();
    p.record({
      toolName: 'start_scope_implement',
      args: { target: 'development' },
      resultText: 'started',
    });
    const snap = p.snapshot('implement this on the development repo');
    expect(snap.hasWrongImplementTarget).toBe(false);
    expect(snap.asyncJobsInProgress).toContain('start_scope_implement');
  });
});

describe('isLaunchPadPollToolForLoopGuard', () => {
  it('recognizes flat and nested poll tools', () => {
    expect(isLaunchPadPollToolForLoopGuard('get_preview_status')).toBe(true);
    expect(
      isLaunchPadPollToolForLoopGuard('mcp_call_tool', 'mcp__LP__get_release_lock_status')
    ).toBe(true);
    expect(isLaunchPadPollToolForLoopGuard('mcp_call_tool', 'start_scope_implement')).toBe(false);
  });
});
