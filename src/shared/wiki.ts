/**
 * Shared Memory Wiki page model (M1 Memory Tree).
 */

export interface WikiSourceRef {
  kind: 'matter' | 'meeting' | 'connector' | 'user' | 'system';
  id?: string;
  label?: string;
  fingerprint?: string;
}

export interface WikiPage {
  id: string;
  path: string;
  title: string;
  body: string;
  score: number;
  sources: WikiSourceRef[];
  divisionKey: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WikiPageInput {
  path: string;
  title: string;
  body: string;
  score?: number;
  sources?: WikiSourceRef[];
  divisionKey?: string | null;
}

export interface WikiSearchResult {
  id: string;
  path: string;
  title: string;
  score: number;
  excerpt: string;
  divisionKey: string | null;
  updatedAt: number;
}

export interface WikiTreeNode {
  path: string;
  title: string;
  isPage: boolean;
  children: WikiTreeNode[];
}
