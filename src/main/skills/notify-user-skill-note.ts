/**
 * Shared instruction appended to every injected skill body so the agent
 * pings the user when work finishes or something needs attention.
 * Skill files that already mention NotifyUser are left unchanged.
 */
export const NOTIFY_USER_SKILL_NOTE = `## Notify the user

When this skill's work is finished, or when something important needs the user and they may not be looking at the chat, call \`NotifyUser\` once before you stop:

- \`title\`: short outcome (a few words)
- \`body\`: one sentence on what happened or what they should do
- \`level\`: \`complete\` when the work is done, \`attention\` when they need to act (decision, failure, blocker, question)

Skip it for greetings, trivial chatter, and intermediate steps (including goal ticks that are still \`in_progress\` and status polls). If the tool says notifications are off or the user is already looking at the app, do not retry.`;

export function withNotifyUserSkillNote(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return trimmed;
  if (/\bNotifyUser\b/.test(trimmed)) return trimmed;
  return `${trimmed}\n\n${NOTIFY_USER_SKILL_NOTE}`;
}
