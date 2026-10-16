import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractOfficeText } from '../../main/utils/office-text';
import { resolvePdfPython } from '../../main/utils/pdf-text';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PR = 'http://schemas.openxmlformats.org/package/2006/relationships';

const rels = (targets: Record<string, string>) =>
  `<Relationships xmlns="${PR}">${Object.entries(targets)
    .map(([id, target]) => `<Relationship Id="${id}" Target="${target}"/>`)
    .join('')}</Relationships>`;

const FIXTURES: Record<string, Record<string, string>> = {
  'sample.docx': {
    'word/document.xml': `<w:document xmlns:w="${W}"><w:body>
      <w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:tab/><w:t>world</w:t></w:r></w:p>
      <w:tbl><w:tr>
        <w:tc><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Role</w:t></w:r></w:p></w:tc>
      </w:tr></w:tbl>
    </w:body></w:document>`,
  },
  'sample.xlsx': {
    'xl/workbook.xml': `<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="Costs" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': rels({ rId1: 'worksheets/sheet1.xml' }),
    'xl/sharedStrings.xml': `<sst xmlns="${S}"><si><t>Item</t></si><si><t>Total</t></si></sst>`,
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="${S}"><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>
      <row r="2"><c r="A2" t="inlineStr"><is><t>VM</t></is></c><c r="C2"><v>42.5</v></c></row>
    </sheetData></worksheet>`,
  },
  'sample.pptx': {
    'ppt/presentation.xml': `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst>
      <p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/>
    </p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels({
      rId2: 'slides/slide1.xml',
      rId3: 'slides/slide2.xml',
    }),
    'ppt/slides/slide1.xml': `<p:sld xmlns:p="${P}" xmlns:a="${A}"><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>`,
    'ppt/slides/slide2.xml': `<p:sld xmlns:p="${P}" xmlns:a="${A}"><a:p><a:r><a:t>First</a:t></a:r></a:p></p:sld>`,
  },
};

let dir = '';

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'office-text-test-'));
  const { python, env } = resolvePdfPython();
  const script =
    'import sys, json, zipfile\n' +
    'for name, parts in json.loads(sys.argv[2]).items():\n' +
    '    with zipfile.ZipFile(sys.argv[1] + "/" + name, "w") as z:\n' +
    '        for part, xml in parts.items(): z.writestr(part, xml)\n';
  execFileSync(python, ['-c', script, dir, JSON.stringify(FIXTURES)], { env });
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('extractOfficeText', () => {
  it('extracts paragraphs and table rows from .docx', async () => {
    const text = await extractOfficeText(path.join(dir, 'sample.docx'), 'docx');
    expect(text).toBe('Hello\tworld\nName | Role');
  });

  it('extracts sheets as tab-separated rows, keeping column positions', async () => {
    const text = await extractOfficeText(path.join(dir, 'sample.xlsx'), 'xlsx');
    expect(text).toBe('## Sheet: Costs\nItem\t\tTotal\nVM\t\t42.5');
  });

  it('extracts slides in presentation order', async () => {
    const text = await extractOfficeText(path.join(dir, 'sample.pptx'), 'pptx');
    expect(text).toBe('## Slide 1\nFirst\n\n## Slide 2\nSecond');
  });
});
