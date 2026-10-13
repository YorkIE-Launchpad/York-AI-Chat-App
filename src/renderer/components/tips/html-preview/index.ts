import { PanelRight } from 'lucide-react';
import { alwaysEligible } from '../eligibility';
import type { TipDefinition } from '../types';
import { HtmlPreviewTip } from './HtmlPreviewTip';

export const htmlPreviewTip: TipDefinition = {
  id: 'html-preview',
  storageKey: 'tip-html-preview-seen-v1',
  category: 'chat',
  defaultSeen: true,
  icon: PanelRight,
  titleKey: 'tips.htmlPreview.title',
  summaryKey: 'tips.htmlPreview.summary',
  isEligible: alwaysEligible,
  View: HtmlPreviewTip,
};
