import type { ReactNode } from 'react';
import {
  File,
  FileArchive,
  FileAudio2,
  FileCode2,
  FilePieChart,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Image as ImageIcon,
} from 'lucide-react';
import { getArtifactIconComponent } from '../../utils/artifact-steps';

interface FileAttachmentChipProps {
  filename: string;
  removeButton?: ReactNode;
  className?: string;
}

function iconForFilename(filename: string) {
  const key = getArtifactIconComponent(filename);
  switch (key) {
    case 'presentation':
      return FilePieChart;
    case 'table':
      return FileSpreadsheet;
    case 'document':
      return FileText;
    case 'code':
      return FileCode2;
    case 'image':
      return ImageIcon;
    case 'audio':
      return FileAudio2;
    case 'video':
      return FileVideo;
    case 'archive':
      return FileArchive;
    case 'text':
      return File;
    default:
      return File;
  }
}

export function FileAttachmentChip({
  filename,
  removeButton,
  className = '',
}: FileAttachmentChipProps) {
  const Icon = iconForFilename(filename);

  return (
    <div
      className={`flex max-w-full min-w-0 items-center gap-2 px-3 py-2 rounded-lg bg-surface-muted border border-border overflow-hidden ${className}`}
    >
      <Icon className="w-4 h-4 text-accent flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-text-primary truncate">{filename}</p>
      </div>
      {removeButton}
    </div>
  );
}
