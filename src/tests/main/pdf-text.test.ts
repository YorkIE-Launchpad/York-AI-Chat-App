import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_PDF_TEXT_MESSAGE,
  annotateReadToolForPdfs,
  createPdfAwareReadOptions,
  isPdfPath,
} from '../../main/utils/pdf-text';

describe('pdf-text helpers', () => {
  it('detects pdf paths case-insensitively', () => {
    expect(isPdfPath('/tmp/doc.pdf')).toBe(true);
    expect(isPdfPath('/tmp/DOC.PDF')).toBe(true);
    expect(isPdfPath('/tmp/notes.md')).toBe(false);
  });

  it('returns extracted text for PDF paths via readFile operations', async () => {
    const extractText = vi.fn(async () => 'Hello from PDF');
    const readFile = vi.fn(async () => Buffer.from('should-not-be-used'));
    const ops = createPdfAwareReadOptions({ extractText, readFile }).operations!;

    const result = await ops.readFile('/workspace/report.pdf');

    expect(extractText).toHaveBeenCalledWith('/workspace/report.pdf');
    expect(readFile).not.toHaveBeenCalled();
    expect(result.toString('utf-8')).toBe('Hello from PDF');
  });

  it('returns an explicit message when PDF has no text layer', async () => {
    const ops = createPdfAwareReadOptions({
      extractText: async () => '   ',
      readFile: async () => Buffer.from('raw'),
    }).operations!;

    const result = await ops.readFile('/tmp/scanned.PDF');
    expect(result.toString('utf-8')).toBe(EMPTY_PDF_TEXT_MESSAGE);
  });

  it('leaves non-PDF files on the normal readFile path', async () => {
    const extractText = vi.fn(async () => 'nope');
    const readFile = vi.fn(async () => Buffer.from('plain text'));
    const ops = createPdfAwareReadOptions({ extractText, readFile }).operations!;

    const result = await ops.readFile('/workspace/readme.md');

    expect(extractText).not.toHaveBeenCalled();
    expect(readFile).toHaveBeenCalledWith('/workspace/readme.md');
    expect(result.toString('utf-8')).toBe('plain text');
  });

  it('propagates extraction failures', async () => {
    const ops = createPdfAwareReadOptions({
      extractText: async () => {
        throw new Error('PDF text extraction requires Python pypdf. Install with: pip install pypdf');
      },
    }).operations!;

    await expect(ops.readFile('/tmp/doc.pdf')).rejects.toThrow(/pypdf/);
  });

  it('annotates the read tool description once', () => {
    const tools = annotateReadToolForPdfs([
      { name: 'read', description: 'Read the contents of a file.' },
      { name: 'bash', description: 'Run a shell command.' },
    ]);

    expect(tools[0].description).toContain('PDF files are returned as extracted plain text');
    expect(tools[1].description).toBe('Run a shell command.');

    const again = annotateReadToolForPdfs(tools);
    expect(again[0].description).toBe(tools[0].description);
  });
});
