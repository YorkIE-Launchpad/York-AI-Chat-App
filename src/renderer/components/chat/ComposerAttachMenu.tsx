import type { ReactNode, RefObject } from 'react';
import {
  BookOpen,
  FileText,
  FolderOpen,
  Hash,
  MessageSquare,
  Mic,
  Package,
  PackageX,
  Paperclip,
  Plus,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ExternalReferenceContent } from '../../../shared/external-reference';

interface ComposerAttachMenuProps {
  menuRef: RefObject<HTMLDivElement>;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  /** Hide everything except "Attach files" (image mode). */
  filesOnly: boolean;
  workingDir?: { label: string; title?: string; disabled: boolean; onChange: () => void } | null;
  onAttachFiles: () => void;
  onMentionSkill?: (() => void) | null;
  onAttachMeeting?: (() => void) | null;
  onPickReference?: ((source: ExternalReferenceContent['source']) => void) | null;
  skillsToggle?: { disabled: boolean; onToggle: () => void } | null;
}

interface Item {
  id: string;
  icon: ReactNode;
  label: string;
  title?: string;
  disabled?: boolean;
  onSelect: () => void;
}

/** "+" menu in the composer: files, working folder, tool references, skills. */
export function ComposerAttachMenu({
  menuRef,
  open,
  onToggle,
  onClose,
  filesOnly,
  workingDir,
  onAttachFiles,
  onMentionSkill,
  onAttachMeeting,
  onPickReference,
  skillsToggle,
}: ComposerAttachMenuProps) {
  const { t } = useTranslation();
  const icon = (node: ReactNode) => <span className="text-text-muted">{node}</span>;

  const files: Item[] = [
    {
      id: 'files',
      icon: icon(<Paperclip className="h-4 w-4" />),
      label: t('welcome.attachFiles'),
      onSelect: onAttachFiles,
    },
  ];
  if (!filesOnly && workingDir) {
    files.push({
      id: 'cwd',
      icon: icon(<FolderOpen className="h-4 w-4" />),
      label: workingDir.label,
      title: workingDir.title,
      disabled: workingDir.disabled,
      onSelect: workingDir.onChange,
    });
  }

  const tools: Item[] = [];
  if (!filesOnly && onAttachMeeting) {
    tools.push({
      id: 'meeting',
      icon: icon(<Mic className="h-4 w-4" />),
      label: t('meetings.attachMeeting'),
      onSelect: onAttachMeeting,
    });
  }
  if (!filesOnly && onPickReference) {
    const refs: Array<[ExternalReferenceContent['source'], ReactNode, string]> = [
      ['drive', <FileText key="d" className="h-4 w-4" />, t('references.drive')],
      ['slack', <MessageSquare key="s" className="h-4 w-4" />, t('references.slack')],
      ['jira', <Hash key="j" className="h-4 w-4" />, t('references.jira')],
      ['confluence', <BookOpen key="c" className="h-4 w-4" />, t('references.confluence')],
    ];
    for (const [source, node, label] of refs) {
      tools.push({ id: source, icon: icon(node), label, onSelect: () => onPickReference(source) });
    }
  }

  const skills: Item[] = [];
  if (!filesOnly && onMentionSkill) {
    skills.push({
      id: 'skill',
      icon: <Package className="h-4 w-4 text-accent" />,
      label: t('skills.mentionFromMenu'),
      onSelect: onMentionSkill,
    });
  }
  if (!filesOnly && skillsToggle) {
    skills.push({
      id: 'skills-toggle',
      icon: skillsToggle.disabled ? (
        <Package className="h-4 w-4 text-accent" />
      ) : (
        icon(<PackageX className="h-4 w-4" />)
      ),
      label: skillsToggle.disabled ? t('skills.enableForChat') : t('skills.disableForChat'),
      onSelect: skillsToggle.onToggle,
    });
  }

  const groups = [
    { id: 'files', label: t('chat.attach.files'), items: files },
    { id: 'tools', label: t('chat.attach.fromTools'), items: tools },
    { id: 'skills', label: t('chat.attach.skills'), items: skills },
  ].filter((g) => g.items.length > 0);

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={onToggle}
        className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
          open
            ? 'bg-surface-active text-text-primary'
            : 'text-text-muted hover:bg-surface-hover hover:text-text-primary'
        }`}
        title={t('meetings.attachMenu')}
        aria-label={t('meetings.attachMenu')}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <Plus className={`h-4 w-4 transition-transform ${open ? 'rotate-45' : ''}`} />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute bottom-[calc(100%+8px)] left-0 z-30 min-w-[14rem] rounded-xl border border-border-subtle bg-surface-raised p-1 shadow-elevated animate-fade-in"
        >
          {groups.map((group, index) => (
            <div
              key={group.id}
              className={index > 0 ? 'mt-1 border-t border-border-muted pt-1' : undefined}
            >
              <p className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-text-muted">
                {group.label}
              </p>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  title={item.title}
                  onClick={() => {
                    onClose();
                    item.onSelect();
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-text-primary transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                >
                  {item.icon}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
