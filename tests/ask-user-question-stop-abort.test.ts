import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const agentRunnerPath = path.resolve(process.cwd(), 'src/main/agent/agent-runner.ts');
const sessionManagerPath = path.resolve(process.cwd(), 'src/main/session/session-manager.ts');
const agentRunnerContent = readFileSync(agentRunnerPath, 'utf8');
const sessionManagerContent = readFileSync(sessionManagerPath, 'utf8');

/**
 * Pins Stop/AskUserQuestion abort wiring so ghost runs and orphaned queues
 * cannot regress silently.
 */
describe('AskUserQuestion stop/abort wiring', () => {
  it('CoworkAgentRunner.cancel aborts the cached piSession', () => {
    const cancelIdx = agentRunnerContent.indexOf('cancel(sessionId: string): void');
    expect(cancelIdx).toBeGreaterThan(-1);
    const cancelBlock = agentRunnerContent.slice(cancelIdx, cancelIdx + 600);
    expect(cancelBlock).toContain('controller.abort()');
    expect(cancelBlock).toContain('cached.session.abort()');
  });

  it('activity timeout reschedules while AskUserQuestion is pending', () => {
    expect(agentRunnerContent).toContain('this.askUserQuestionExtension?.hasPending(session.id)');
    expect(agentRunnerContent).toContain('Waiting on AskUserQuestion is intentional idle');
  });

  it('stopSession dismisses AskUserQuestion before agentRunner.cancel', () => {
    const stopIdx = sessionManagerContent.indexOf('stopSession(sessionId: string): void');
    expect(stopIdx).toBeGreaterThan(-1);
    const stopBlock = sessionManagerContent.slice(stopIdx, stopIdx + 900);
    const dismissIdx = stopBlock.indexOf('dismissSessionQuestions');
    const cancelIdx = stopBlock.indexOf('this.agentRunner.cancel');
    expect(dismissIdx).toBeGreaterThan(-1);
    expect(cancelIdx).toBeGreaterThan(dismissIdx);
  });

  it('tool_execution_end is still handled after Stop so the tool trace step closes', () => {
    expect(agentRunnerContent).toContain(
      "if (controller.signal.aborted && event.type !== 'tool_execution_end') return;"
    );
    const endIdx = agentRunnerContent.indexOf("case 'tool_execution_end': {");
    expect(endIdx).toBeGreaterThan(-1);
    const endBlock = agentRunnerContent.slice(endIdx, endIdx + 200);
    expect(endBlock).not.toContain('if (controller.signal.aborted) break;');
    expect(endBlock).toContain('openToolTraceSteps.delete(toolCallId)');
  });

  it('run cleanup closes tool trace steps that never finished', () => {
    const loopIdx = agentRunnerContent.indexOf(
      'for (const [openToolCallId, openToolName] of openToolTraceSteps)'
    );
    expect(loopIdx).toBeGreaterThan(-1);
    const loopBlock = agentRunnerContent.slice(loopIdx, loopIdx + 300);
    expect(loopBlock).toContain("status: 'error'");
  });

  it('processQueue finally restarts when leftover prompts remain', () => {
    expect(sessionManagerContent).toContain('Restarting queue after unwind with leftover prompts');
    expect(sessionManagerContent).toContain('leftover.length > 0');
  });
});
