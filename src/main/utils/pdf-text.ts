/**
 * PDF text extraction for agent Read and chat import.
 * Uses python3 + pypdf (or PyPDF2) — same approach as the pdf skill.
 */
import { execFile } from 'child_process';
import { constants as fsConstants, existsSync } from 'fs';
import { access as fsAccess, readFile as fsReadFile } from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import type { ReadToolOptions } from '@mariozechner/pi-coding-agent';

const execFileAsync = promisify(execFile);

const EMPTY_PDF_TEXT_MESSAGE =
  '[This PDF has no extractable text layer (it may be scanned/image-only). Use the pdf skill with OCR if you need content from images.]';

const PDF_READ_DESCRIPTION_NOTE =
  ' PDF files are returned as extracted plain text (via pypdf), not raw binary.';

export function isPdfPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.pdf');
}

type PythonExec = { python: string; env: NodeJS.ProcessEnv };

/**
 * Prefer the app-bundled runtime (ships pypdf in `<root>/site-packages`, see
 * scripts/prepare-python.js); fall back to whatever python3 is on PATH.
 */
export function resolvePdfPython(): PythonExec {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const roots: string[] = [];
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) roots.push(path.join(resourcesPath, 'python'));
  for (const projectRoot of [path.join(__dirname, '..', '..'), process.cwd()]) {
    roots.push(path.join(projectRoot, 'resources', 'python', `${process.platform}-${arch}`));
  }

  for (const root of roots) {
    const python = path.join(root, 'bin', 'python3');
    const siteDir = path.join(root, 'site-packages');
    if (!existsSync(python) || !existsSync(path.join(siteDir, 'pypdf'))) continue;
    return {
      python,
      env: {
        ...process.env,
        PYTHONHOME: root,
        PYTHONPATH: [siteDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
        PYTHONNOUSERSITE: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONUTF8: '1',
      },
    };
  }
  return { python: 'python3', env: process.env };
}

/**
 * Extract text from a PDF using python3 + pypdf/PyPDF2.
 * Returns an empty string when the PDF has no text layer.
 */
export async function extractPdfText(filePath: string): Promise<string> {
  const script = `
import sys
path = sys.argv[1]
try:
    from pypdf import PdfReader
except ImportError:
    try:
        from PyPDF2 import PdfReader
    except ImportError:
        sys.stderr.write('pypdf is not installed')
        sys.exit(2)
reader = PdfReader(path)
parts = []
for page in reader.pages:
    t = page.extract_text() or ''
    if t.strip():
        parts.append(t)
sys.stdout.write('\\n'.join(parts))
`;
  const { python, env } = resolvePdfPython();
  try {
    const { stdout } = await execFileAsync(python, ['-c', script, filePath], {
      env,
      maxBuffer: 20 * 1024 * 1024,
      timeout: 60_000,
    });
    return stdout || '';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/pypdf is not installed/i.test(message) || /exit code 2/i.test(message)) {
      throw new Error('PDF text extraction requires Python pypdf. Install with: pip install pypdf');
    }
    throw new Error(`Failed to extract PDF text: ${message}`);
  }
}

export type PdfAwareReadDeps = {
  readFile?: (absolutePath: string) => Promise<Buffer>;
  access?: (absolutePath: string) => Promise<void>;
  extractText?: (absolutePath: string) => Promise<string>;
};

/**
 * Pi ReadToolOptions that return extracted text for .pdf paths
 * (so offset/limit/truncation still apply on the text).
 */
export function createPdfAwareReadOptions(deps: PdfAwareReadDeps = {}): ReadToolOptions {
  const readFile = deps.readFile ?? ((p: string) => fsReadFile(p));
  const access = deps.access ?? ((p: string) => fsAccess(p, fsConstants.R_OK));
  const extractText = deps.extractText ?? extractPdfText;

  return {
    operations: {
      access,
      readFile: async (absolutePath: string) => {
        if (!isPdfPath(absolutePath)) {
          return readFile(absolutePath);
        }
        const text = await extractText(absolutePath);
        const output = text.trim() ? text : EMPTY_PDF_TEXT_MESSAGE;
        return Buffer.from(output, 'utf-8');
      },
    },
  };
}

/** Append PDF extraction note to the built-in read tool description. */
export function annotateReadToolForPdfs<T extends { name: string; description?: string }>(
  tools: T[]
): T[] {
  return tools.map((tool) => {
    if (tool.name.toLowerCase() !== 'read') return tool;
    const description = tool.description ?? '';
    if (description.includes(PDF_READ_DESCRIPTION_NOTE.trim())) return tool;
    return { ...tool, description: `${description}${PDF_READ_DESCRIPTION_NOTE}` };
  });
}

export { EMPTY_PDF_TEXT_MESSAGE };
