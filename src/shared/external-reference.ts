/**
 * Composer / transcript types for Drive, Slack, and Jira references.
 */

export type ExternalReferenceSource = 'drive' | 'slack' | 'jira';

export interface ExternalReferenceContent {
  type: 'external_reference';
  source: ExternalReferenceSource;
  externalId: string;
  title: string;
  url?: string;
  subtitle?: string;
  meta?: Record<string, string>;
}

export interface ExternalReferenceSearchItem {
  source: ExternalReferenceSource;
  externalId: string;
  title: string;
  url?: string;
  subtitle?: string;
  meta?: Record<string, string>;
}

export interface ExternalReferenceSearchResult {
  items: ExternalReferenceSearchItem[];
  error?: string;
  disconnected?: boolean;
}

export interface ExternalReferenceResolveResult {
  text: string;
  title: string;
  url?: string;
  error?: string;
}

export interface ExternalReferenceConnectorStatus {
  drive: boolean;
  slack: boolean;
  jira: boolean;
}

export const EXTERNAL_REFERENCE_PROMPT_CAP = 12_000;
