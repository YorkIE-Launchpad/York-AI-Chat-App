/**
 * Text extraction for Office Open XML files (.docx / .xlsx / .pptx).
 * Uses python3 with the standard library only (zipfile + ElementTree), via the
 * same interpreter resolution as PDF extraction.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolvePdfPython } from './pdf-text';

const execFileAsync = promisify(execFile);

export type OfficeFormat = 'docx' | 'xlsx' | 'pptx';

export const OFFICE_MIME_FORMATS: Readonly<Record<string, OfficeFormat>> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

const OFFICE_TEXT_SCRIPT = `
import sys, re, zipfile, posixpath
import xml.etree.ElementTree as ET

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
A = '{http://schemas.openxmlformats.org/drawingml/2006/main}'
S = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
P = '{http://schemas.openxmlformats.org/presentationml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
PR = '{http://schemas.openxmlformats.org/package/2006/relationships}'
MC_FALLBACK = '{http://schemas.openxmlformats.org/markup-compatibility/2006}Fallback'
MAX_MEMBER_BYTES = 200 * 1024 * 1024
MAX_SHEET_ROWS = 5000

kind, path = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(path)
names = set(z.namelist())

def read_xml(name):
    if z.getinfo(name).file_size > MAX_MEMBER_BYTES:
        raise ValueError('document part too large: ' + name)
    return ET.fromstring(z.read(name))

def rels(part):
    d, b = posixpath.split(part)
    rp = posixpath.join(d, '_rels', b + '.rels')
    if rp not in names:
        return {}
    out = {}
    for r in read_xml(rp).iter(PR + 'Relationship'):
        target = r.get('Target') or ''
        full = target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join(d, target))
        out[r.get('Id')] = full
    return out

def run_text(el, ns, buf, nested):
    for c in el:
        if c.tag == MC_FALLBACK:
            continue
        if c.tag == ns + 'p':
            nested.append(c)
            continue
        if c.tag == ns + 't' and c.text:
            buf.append(c.text)
        elif c.tag == ns + 'tab':
            buf.append('\\t')
        elif c.tag in (ns + 'br', ns + 'cr'):
            buf.append('\\n')
        run_text(c, ns, buf, nested)

def walk_docx(el, lines):
    if el.tag == MC_FALLBACK:
        return
    if el.tag == W + 'p':
        buf, nested = [], []
        run_text(el, W, buf, nested)
        lines.append(''.join(buf))
        for n in nested:
            walk_docx(n, lines)
        return
    if el.tag == W + 'tr':
        cells = []
        for tc in el.findall(W + 'tc'):
            sub = []
            for c in tc:
                walk_docx(c, sub)
            cells.append(' '.join(s.strip() for s in sub if s.strip()))
        if any(cells):
            lines.append(' | '.join(cells))
        return
    for c in el:
        walk_docx(c, lines)

def docx():
    lines = []
    for part in ('word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml'):
        if part in names:
            walk_docx(read_xml(part), lines)
    return '\\n'.join(l for l in lines if l.strip())

def pptx():
    rm = rels('ppt/presentation.xml')
    slides = [rm.get(s.get(R + 'id')) for s in read_xml('ppt/presentation.xml').iter(P + 'sldId')]
    out = []
    for i, part in enumerate(slides, 1):
        if not part or part not in names:
            continue
        paras = []
        for p in read_xml(part).iter(A + 'p'):
            buf = []
            run_text(p, A, buf, [])
            if ''.join(buf).strip():
                paras.append(''.join(buf))
        out.append('## Slide %d\\n%s' % (i, '\\n'.join(paras)))
    return '\\n\\n'.join(out)

def col_index(ref):
    m = re.match(r'[A-Z]+', ref or '')
    if not m:
        return None
    n = 0
    for ch in m.group(0):
        n = n * 26 + (ord(ch) - 64)
    return n - 1

def xlsx():
    shared = []
    if 'xl/sharedStrings.xml' in names:
        for si in read_xml('xl/sharedStrings.xml').iter(S + 'si'):
            shared.append(''.join(t.text or '' for t in si.iter(S + 't')))
    rm = rels('xl/workbook.xml')
    out = []
    for sheet in read_xml('xl/workbook.xml').iter(S + 'sheet'):
        part = rm.get(sheet.get(R + 'id'))
        if not part or part not in names:
            continue
        rows = []
        truncated = False
        for row in read_xml(part).iter(S + 'row'):
            if len(rows) >= MAX_SHEET_ROWS:
                truncated = True
                break
            values = []
            for c in row.findall(S + 'c'):
                t = c.get('t')
                v = c.find(S + 'v')
                if t == 's':
                    val = shared[int(v.text)] if v is not None and v.text and int(v.text) < len(shared) else ''
                elif t == 'inlineStr':
                    is_ = c.find(S + 'is')
                    val = ''.join(x.text or '' for x in is_.iter(S + 't')) if is_ is not None else ''
                elif t == 'b':
                    val = 'TRUE' if v is not None and v.text == '1' else 'FALSE'
                else:
                    val = v.text if v is not None and v.text else ''
                idx = col_index(c.get('r'))
                if idx is None:
                    idx = len(values)
                while len(values) < idx:
                    values.append('')
                values.append(val.replace('\\t', ' ').replace('\\n', ' '))
            while values and not values[-1]:
                values.pop()
            if values:
                rows.append('\\t'.join(values))
        if truncated:
            rows.append('[truncated after %d rows]' % MAX_SHEET_ROWS)
        out.append('## Sheet: %s\\n%s' % (sheet.get('name') or part, '\\n'.join(rows)))
    return '\\n\\n'.join(out)

handlers = {'docx': docx, 'xlsx': xlsx, 'pptx': pptx}
sys.stdout.write(handlers[kind]())
`;

export async function extractOfficeText(filePath: string, format: OfficeFormat): Promise<string> {
  const { python, env } = resolvePdfPython();
  try {
    const { stdout } = await execFileAsync(python, ['-c', OFFICE_TEXT_SCRIPT, format, filePath], {
      env: { ...env, PYTHONIOENCODING: 'utf-8' },
      maxBuffer: 50 * 1024 * 1024,
      timeout: 60_000,
    });
    return stdout || '';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to extract .${format} text: ${message}`);
  }
}
