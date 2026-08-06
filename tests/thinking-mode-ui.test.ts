import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Thinking mode UI wiring', () => {
  it('exposes a Think control in chat and welcome composers', () => {
    const chat = fs.readFileSync(
      path.resolve(process.cwd(), 'src/renderer/components/ChatView.tsx'),
      'utf8'
    );
    const welcome = fs.readFileSync(
      path.resolve(process.cwd(), 'src/renderer/components/WelcomeView.tsx'),
      'utf8'
    );
    expect(chat).toContain('ThinkingModeToggle');
    expect(welcome).toContain('ThinkingModeToggle');
  });

  it('uses high thinking level when enableThinking is on in the agent runner', () => {
    const runner = fs.readFileSync(
      path.resolve(process.cwd(), 'src/main/agent/agent-runner.ts'),
      'utf8'
    );
    expect(runner).toContain('resolveThinkingLevel');
    expect(runner).toContain('buildThinkingModePromptSection');
    expect(runner).not.toMatch(/enableThinking \? ['"]medium['"]/);
  });
});
