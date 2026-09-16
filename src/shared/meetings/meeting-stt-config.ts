import type { MeetingSttProvider } from './meeting-stt-provider';

export interface MeetingSttProviderConfig {
  requested: MeetingSttProvider;
  platform: string;
  /** macOS 26+ with speech helper present */
  appleSupported: boolean;
}
