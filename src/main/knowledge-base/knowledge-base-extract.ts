/**
 * Plain-text extraction for knowledge base files.
 * PDFs use pypdf; Office Open XML (docx/pptx/xlsx) uses Python's stdlib zipfile.
 */
import { execFile } from 'child_process';
import { readFile, stat } from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { extractPdfText, resolvePdfPython } from '../utils/pdf-text';

const execFileAsync = promisify(execFile);

export const MAX_KNOWLEDGE_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_KNOWLEDGE_TEXT_CHARS = 2_000_000;

const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'mdx',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'xml',
  'html',
  'htm',
  'log',
  'ini',
  'toml',
  'cfg',
  'conf',
  'env',
  'sql',
  'rtf',
  'tex',
  'srt',
  'vtt',
  'js',
  'jsx',
  'ts',
  'tsx',
  'mjs',
  'cjs',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'php',
  'sh',
  'zsh',
  'bash',
  'ps1',
  'css',
  'scss',
  'less',
  'vue',
  'svelte',
  'graphql',
  'proto',
]);

const OFFICE_EXTENSIONS = new Set(['docx', 'pptx', 'xlsx']);

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'tiff']);

const OFFICE_SCRIPT = `
import sys, zipfile, re
import xml.etree.ElementTree as ET

path, ext = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(path)

def texts(xml, para_tags, text_tag):
    root = ET.fromstring(xml)
    out = []
    for el in root.iter():
        tag = el.tag.split('}')[-1]
        if tag in para_tags:
            line = ''.join((t.text or '') for t in el.iter() if t.tag.split('}')[-1] == text_tag)
            if line.strip():
                out.append(line)
    return out

def natural(name):
    return [int(p) if p.isdigit() else p for p in re.split(r'(\\d+)', name)]

parts = []
if ext == 'docx':
    names = ['word/document.xml'] + sorted(n for n in z.namelist() if re.match(r'word/(header|footer|footnotes)\\d*\\.xml$', n))
    for n in names:
        if n in z.namelist():
            parts.extend(texts(z.read(n), {'p'}, 't'))
elif ext == 'pptx':
    slides = sorted((n for n in z.namelist() if re.match(r'ppt/slides/slide\\d+\\.xml$', n)), key=natural)
    for i, n in enumerate(slides, 1):
        lines = texts(z.read(n), {'p'}, 't')
        if lines:
            parts.append('## Slide %d' % i)
            parts.extend(lines)
elif ext == 'xlsx':
    shared = []
    if 'xl/sharedStrings.xml' in z.namelist():
        root = ET.fromstring(z.read('xl/sharedStrings.xml'))
        for si in root:
            shared.append(''.join((t.text or '') for t in si.iter() if t.tag.split('}')[-1] == 't'))
    sheets = sorted((n for n in z.namelist() if re.match(r'xl/worksheets/sheet\\d+\\.xml$', n)), key=natural)
    for i, n in enumerate(sheets, 1):
        parts.append('## Sheet %d' % i)
        root = ET.fromstring(z.read(n))
        for row in root.iter():
            if row.tag.split('}')[-1] != 'row':
                continue
            cells = []
            for c in row:
                if c.tag.split('}')[-1] != 'c':
                    continue
                kind = c.get('t')
                value = ''
                for child in c.iter():
                    t = child.tag.split('}')[-1]
                    if t == 'v' and child.text is not None:
                        value = child.text
                    elif t == 't' and kind == 'inlineStr':
                        value += child.text or ''
                if kind == 's' and value.isdigit() and int(value) < len(shared):
                    value = shared[int(value)]
                cells.append(value)
            if any(v.strip() for v in cells):
                parts.append(' | '.join(cells))
sys.stdout.write('\\n'.join(parts))
`;

export function fileExtension(filePath: string): string {
  return path.extname(filePath).slice(1).toLowerCase();
}

export function isImagePath(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(fileExtension(filePath));
}

async function extractOfficeText(filePath: string, ext: string): Promise<string> {
  const { python, env } = resolvePdfPython();
  const { stdout } = await execFileAsync(python, ['-c', OFFICE_SCRIPT, filePath, ext], {
    env,
    maxBuffer: 40 * 1024 * 1024,
    timeout: 60_000,
  });
  return stdout || '';
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return sample.length > 0 && suspicious / sample.length > 0.1;
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function normalizeExtractedText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_KNOWLEDGE_TEXT_CHARS);
}

/** Extract searchable text from a local file. Throws with a user-facing message on failure. */
export async function extractKnowledgeText(filePath: string): Promise<string> {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error('Not a file.');
  if (info.size > MAX_KNOWLEDGE_FILE_BYTES) {
    throw new Error(`File is larger than ${MAX_KNOWLEDGE_FILE_BYTES / (1024 * 1024)} MB.`);
  }
  const ext = fileExtension(filePath);
  if (IMAGE_EXTENSIONS.has(ext)) {
    throw new Error('Images have no text to index.');
  }

  let text: string;
  if (ext === 'pdf') {
    text = await extractPdfText(filePath);
    if (!text.trim()) {
      throw new Error('This PDF has no extractable text layer (it may be scanned).');
    }
  } else if (OFFICE_EXTENSIONS.has(ext)) {
    text = await extractOfficeText(filePath, ext);
  } else {
    const buffer = await readFile(filePath);
    if (!TEXT_EXTENSIONS.has(ext) && looksBinary(buffer)) {
      throw new Error(`Unsupported file type${ext ? ` (.${ext})` : ''}.`);
    }
    text = buffer.toString('utf-8');
    if (ext === 'html' || ext === 'htm') text = stripHtml(text);
  }

  const normalized = normalizeExtractedText(text);
  if (!normalized) throw new Error('No text found in this file.');
  return normalized;
}

/**
 * Split text into ~`target`-char chunks on paragraph/sentence boundaries with
 * a small overlap so passages that straddle a boundary stay searchable.
 */
export function chunkKnowledgeText(text: string, target = 1200, overlap = 150): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= target) return [clean];

  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(clean.length, start + target);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const minBreak = Math.floor(target * 0.5);
      const breaks = [
        window.lastIndexOf('\n\n'),
        window.lastIndexOf('\n'),
        window.lastIndexOf('. '),
        window.lastIndexOf(' '),
      ];
      const cut = breaks.find((index) => index >= minBreak);
      if (cut !== undefined) end = start + cut + 1;
    }
    const chunk = clean.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}
