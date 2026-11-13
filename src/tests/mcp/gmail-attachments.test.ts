import { mkdtemp, readFile, rm } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  extractReadableBody,
  formatAttachmentListing,
  listGmailAttachments,
  safeAttachmentFilename,
  saveAttachmentFile,
  selectAttachments,
} from '../../main/mcp/gmail-attachments';

const sampleMessage = {
  mimeType: 'multipart/mixed',
  parts: [
    {
      mimeType: 'multipart/alternative',
      parts: [
        {
          partId: '0.0',
          mimeType: 'text/plain',
          body: { data: Buffer.from('Hello from the body').toString('base64url'), size: 19 },
        },
        {
          partId: '0.1',
          mimeType: 'text/html',
          body: { data: Buffer.from('<p>Hello</p>').toString('base64url'), size: 12 },
        },
      ],
    },
    {
      partId: '1',
      mimeType: 'application/pdf',
      filename: 'invoice.pdf',
      body: { attachmentId: 'att-pdf', size: 2048 },
    },
    {
      partId: '2',
      mimeType: 'application/octet-stream',
      filename: '',
      headers: [{ name: 'Content-Disposition', value: 'attachment; filename="notes.txt"' }],
      body: { attachmentId: 'att-notes', size: 40 },
    },
  ],
};

describe('gmail attachments', () => {
  it('lists file parts and skips the message body', () => {
    const attachments = listGmailAttachments(sampleMessage);
    expect(attachments.map((item) => item.filename)).toEqual(['invoice.pdf', 'notes.txt']);
    expect(attachments[0]?.attachmentId).toBe('att-pdf');
    expect(extractReadableBody(sampleMessage)).toContain('Hello from the body');
    expect(extractReadableBody(sampleMessage)).not.toContain('invoice');
    expect(formatAttachmentListing(attachments)).toContain('download_attachment');
  });

  it('selects one file by id, filename, or every file', () => {
    const attachments = listGmailAttachments(sampleMessage);
    expect(selectAttachments(attachments, 'att-pdf', '').map((item) => item.filename)).toEqual([
      'invoice.pdf',
    ]);
    expect(selectAttachments(attachments, '', 'notes.txt')).toHaveLength(1);
    expect(selectAttachments(attachments, '', '')).toHaveLength(2);
    expect(selectAttachments(attachments, '', 'missing')).toHaveLength(0);
  });

  it('saves bytes under a safe unique filename', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gmail-att-'));
    try {
      expect(safeAttachmentFilename('../../secret.pdf')).toBe('secret.pdf');
      const first = await saveAttachmentFile(dir, '../invoice.pdf', Buffer.from('one'));
      const second = await saveAttachmentFile(dir, 'invoice.pdf', Buffer.from('two'));
      expect(path.basename(first)).toBe('invoice.pdf');
      expect(path.basename(second)).toBe('invoice-1.pdf');
      expect(await readFile(first, 'utf8')).toBe('one');
      expect(await readFile(second, 'utf8')).toBe('two');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
