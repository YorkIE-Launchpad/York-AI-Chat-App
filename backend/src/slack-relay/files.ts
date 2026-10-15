/**
 * Slack file objects attached to a DM → the images forwarded to the desktop.
 */
import { IMAGE_LIMITS, cleanLine } from './protocol.js';
import { isSlackFileUrl } from './slack-api.js';

export interface InboundSlackFile {
  id: string;
  name: string;
  /** Slack's declared mimetype starts with `image/`. */
  isImage: boolean;
  /** Download URLs to try in order: the original when small enough, then thumbnails. */
  urls: string[];
}

/** Largest first; Slack renders these for images and keeps them well under the size cap. */
const THUMBNAIL_KEYS = ['thumb_1024', 'thumb_960', 'thumb_720', 'thumb_480', 'thumb_360'];

const FILE_ID_RE = /^F[A-Z0-9]{1,30}$/;

export function toInboundFile(raw: unknown): InboundSlackFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const file = raw as Record<string, unknown>;
  const id = typeof file.id === 'string' && FILE_ID_RE.test(file.id) ? file.id : '';
  if (!id) return null;
  const name =
    cleanLine(file.name, IMAGE_LIMITS.fileNameMax) ??
    cleanLine(file.title, IMAGE_LIMITS.fileNameMax) ??
    'file';
  const mimetype = typeof file.mimetype === 'string' ? file.mimetype : '';
  const size = typeof file.size === 'number' ? file.size : Number.POSITIVE_INFINITY;

  const urls: string[] = [];
  if (size <= IMAGE_LIMITS.imageMaxBytes) {
    for (const key of ['url_private_download', 'url_private']) {
      if (isSlackFileUrl(file[key])) {
        urls.push(file[key] as string);
        break;
      }
    }
  }
  for (const key of THUMBNAIL_KEYS) {
    if (isSlackFileUrl(file[key])) urls.push(file[key] as string);
  }
  return { id, name, isImage: mimetype.startsWith('image/'), urls };
}

/** Events for some files only say `file_access: check_file_info`; their details need `files.info`. */
export function needsFileInfo(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const file = raw as Record<string, unknown>;
  return file.file_access === 'check_file_info' || typeof file.mimetype !== 'string';
}
