import { useTranslation } from 'react-i18next';
import { FileSpreadsheet, FileText, Presentation } from 'lucide-react';
import { TipModal } from '../TipModal';
import { DemoFrame, MiniComposer, MiniList } from '../demo';
import type { TipViewProps } from '../types';

export function SlashSkillsTip({ onDismiss }: TipViewProps) {
  const { t } = useTranslation();
  return (
    <TipModal
      title={t('tips.slashSkills.title')}
      body={t('tips.slashSkills.body')}
      media={
        <DemoFrame windowTitle="GrowthOS">
          <MiniComposer
            className="absolute inset-x-2 bottom-2"
            text={t('tips.slashSkills.demoText')}
            menu={
              <MiniList
                className="shadow-elevated"
                rows={[
                  { icon: Presentation, label: 'pptx', meta: t('tips.slashSkills.demoPptx') },
                  { icon: FileText, label: 'docx', meta: t('tips.slashSkills.demoDocx') },
                  { icon: FileSpreadsheet, label: 'xlsx', meta: t('tips.slashSkills.demoXlsx') },
                ]}
              />
            }
          />
        </DemoFrame>
      }
      onDismiss={onDismiss}
    />
  );
}
