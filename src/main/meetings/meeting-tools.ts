import { Type } from '@sinclair/typebox';
import type { AgentRuntimeCustomTool } from '../extensions/agent-runtime-extension';
import type { MeetingService } from './meeting-service';

export function createMeetingTools(meetingService: MeetingService): AgentRuntimeCustomTool[] {
  const searchTool: AgentRuntimeCustomTool = {
    name: 'meeting_search',
    label: 'meeting_search',
    description:
      'Search saved meeting notes by title, summary, topics, or transcript text. Returns compact results (id, title, summary, date). Use meeting_read for full details.',
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: 'What to search for in meetings.' }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    async execute(_toolCallId, params) {
      if (!meetingService.isChatReferenceAllowed()) {
        return {
          content: [
            { type: 'text' as const, text: 'Meeting chat reference is disabled in Settings.' },
          ],
          details: undefined,
        };
      }
      const query = String((params as { query?: string }).query || '');
      const limit = (params as { limit?: number }).limit;
      const results = meetingService.search(query, limit);
      if (!results.length) {
        return {
          content: [{ type: 'text' as const, text: 'No meetings matched that query.' }],
          details: undefined,
        };
      }
      const lines = results.map((item) =>
        [
          `- id: ${item.id}`,
          `  title: ${item.title}`,
          `  date: ${new Date(item.startedAt).toISOString()}`,
          `  summary: ${item.summary || '(none)'}`,
          `  status: ${item.status}`,
        ].join('\n')
      );
      return {
        content: [{ type: 'text' as const, text: lines.join('\n\n') }],
        details: undefined,
      };
    },
  };

  const readTool: AgentRuntimeCustomTool = {
    name: 'meeting_read',
    label: 'meeting_read',
    description:
      'Read a saved meeting by id. Returns auto-generated title, summary, action items, and key topics. Set includeTranscript=true to also return the raw transcript.',
    parameters: Type.Object({
      id: Type.String({ minLength: 1, description: 'Meeting id from meeting_search.' }),
      includeTranscript: Type.Optional(
        Type.Boolean({
          description: 'When true, include the full raw transcript.',
        })
      ),
    }),
    async execute(_toolCallId, params) {
      if (!meetingService.isChatReferenceAllowed()) {
        return {
          content: [
            { type: 'text' as const, text: 'Meeting chat reference is disabled in Settings.' },
          ],
          details: undefined,
        };
      }
      const id = String((params as { id?: string }).id || '');
      const includeTranscript = Boolean(
        (params as { includeTranscript?: boolean }).includeTranscript
      );
      const meeting = meetingService.get(id);
      if (!meeting) {
        return {
          content: [{ type: 'text' as const, text: `Meeting not found: ${id}` }],
          details: undefined,
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: meetingService.formatMeetingForPrompt(meeting, includeTranscript),
          },
        ],
        details: undefined,
      };
    },
  };

  return [searchTool, readTool];
}
