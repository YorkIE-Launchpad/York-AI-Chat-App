import type {
  AgentRuntimeExtension,
  BeforeSessionRunResult,
} from '../extensions/agent-runtime-extension';
import type { MeetingService } from './meeting-service';
import { createMeetingTools } from './meeting-tools';

export class MeetingExtension implements AgentRuntimeExtension {
  readonly name = 'meetings';

  constructor(private readonly meetingService: MeetingService) {}

  async beforeSessionRun(): Promise<BeforeSessionRunResult | void> {
    if (!this.meetingService.isChatReferenceAllowed()) {
      return;
    }
    return {
      customTools: createMeetingTools(this.meetingService),
    };
  }
}
