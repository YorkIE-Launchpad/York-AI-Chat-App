/** Payload returned when a What's New modal should be shown after upgrade. */
export interface WhatsNewPayload {
  /** Exclusive: user's previously seen version (the one they upgraded from). */
  fromVersion: string;
  /** Inclusive: currently installed app version. */
  toVersion: string;
  /** Combined, newest-first markdown for the modal body. */
  markdown: string;
}
