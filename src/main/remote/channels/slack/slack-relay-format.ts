/**
 * Human-friendly text for the Slack relay: progress labels, approval summaries,
 * chat-picker timestamps, and the answer footer.
 */
import { SLACK_RELAY_SLASH_COMMAND, type SlackRelayCommandName } from './slack-relay-protocol';

const TOOL_LABELS: Array<[RegExp, string]> = [
  [/^(read|glob|grep|ls|list|listdir|list_dir|readfile|read_file|view)$/i, 'Reading files'],
  [/^(bash|shell|exec|run|terminal|run_command|powershell)$/i, 'Running a command'],
  [/^(edit|write|multiedit|notebookedit|str_replace|create_file|apply_patch)$/i, 'Editing files'],
  [/^websearch$|^web_search$/i, 'Searching the web'],
  [/^webfetch$|^web_fetch$|^fetch$/i, 'Reading a web page'],
  [/^(task|agent|subagent)$/i, 'Working on a sub-task'],
  [/^(todowrite|todo_write|plan)$/i, 'Planning'],
  [/^(askuserquestion|ask_user_question)$/i, 'Waiting for your answer'],
];

const MCP_SERVER_LABELS: Record<string, string> = {
  chrome: 'the browser',
  'chrome-devtools': 'the browser',
  playwright: 'the browser',
};

function humanize(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Progress label for a tool call, e.g. `Bash` → "Running a command". */
export function slackStatusLabelForTool(toolName: string): string {
  const name = toolName.trim();
  const mcp = /^mcp__([^_]+(?:[_-][^_]+)*?)__(.+)$/.exec(name);
  if (mcp) {
    const server = mcp[1].replace(/^user-/, '');
    const known = MCP_SERVER_LABELS[server.toLowerCase()];
    return `Using ${known ?? titleCase(humanize(server))}`;
  }
  for (const [pattern, label] of TOOL_LABELS) {
    if (pattern.test(name)) return label;
  }
  const readable = humanize(name).slice(0, 60);
  return readable ? `Using ${readable}` : 'Working…';
}

function firstString(input: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function clip(value: string, max: number): string {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** One-line, readable summary of what a tool call will do. */
export function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  const label = slackStatusLabelForTool(toolName);
  const command = firstString(input, ['command', 'cmd', 'script']);
  if (command) return clip(`Command: ${command}`, 280);
  const file = firstString(input, [
    'file_path',
    'path',
    'filePath',
    'target_file',
    'notebook_path',
  ]);
  if (file) return clip(`${label}: ${file}`, 280);
  const url = firstString(input, ['url', 'uri']);
  if (url) return clip(`${label}: ${url}`, 280);
  const query = firstString(input, ['query', 'pattern', 'search', 'q']);
  if (query) return clip(`${label}: ${query}`, 280);
  const description = firstString(input, ['description', 'prompt', 'title', 'name']);
  if (description) return clip(`${label}: ${description}`, 280);
  return label;
}

/** Short relative time for the chat picker, e.g. "5 min ago", "Yesterday", "Mar 3". */
export function formatUpdatedLabel(updatedAt: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - updatedAt);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  if (hours < 48) return 'Yesterday';
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} days ago`;
  return new Date(updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Footer under every Slack answer. */
export function formatAnswerFooter(chatTitle: string | null | undefined): string {
  const c = SLACK_RELAY_SLASH_COMMAND;
  const title = clip(chatTitle?.trim() || 'Untitled chat', 80);
  return `Chat: ${title}  ·  ${c} chats  ·  ${c} new`;
}

export function slackRelayHelpText(): string {
  const c = SLACK_RELAY_SLASH_COMMAND;
  return [
    '*Control York IE from Slack*',
    'Just send a message to work in your current chat, or use:',
    `• \`${c} new\` (or \`${c} new <message>\`) – start a fresh chat`,
    `• \`${c} chats\` – pick one of your recent chats`,
    `• \`${c} stop\` – stop what York IE is doing`,
    `• \`${c} status\` – show the current chat and whether it's busy`,
    `• \`help\` – show this help`,
  ].join('\n');
}

const TEXT_COMMAND_ALIASES: Record<string, Exclude<SlackRelayCommandName, 'open'>> = {
  new: 'new',
  reset: 'new',
  chats: 'chats',
  chat: 'chats',
  list: 'chats',
  ls: 'chats',
  stop: 'stop',
  cancel: 'stop',
  abort: 'stop',
  status: 'status',
  help: 'help',
  '?': 'help',
};

/**
 * Commands typed as a plain DM: a bare `help`, or `/growth …` / `/growthos …`
 * sent as text (Slack doesn't run slash commands inside threads).
 */
export function parseSlackTextCommand(
  text: string
): { name: Exclude<SlackRelayCommandName, 'open'>; arg?: string } | null {
  const trimmed = text.trim();
  if (/^(help|\?)[.!?]*$/i.test(trimmed)) return { name: 'help' };
  const slash = /^\/growth(?:os)?(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!slash) return null;
  const rest = (slash[1] ?? '').trim();
  if (!rest) return { name: 'help' };
  const first = rest.split(/\s+/)[0];
  const name = TEXT_COMMAND_ALIASES[first.toLowerCase()] ?? 'help';
  const arg = rest.slice(first.length).trim();
  return name === 'new' && arg ? { name, arg } : { name };
}
