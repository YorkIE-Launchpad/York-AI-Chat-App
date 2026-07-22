import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  mapHubSkillRows,
  normalizeAiSkillsListResponse,
  resolveExtractedSkillRoot,
  listAiSkills,
  HubSkillsLibraryError,
} from '../../main/skills/hub-skills-library-service';

describe('hub-skills-library-service', () => {
  describe('normalizeAiSkillsListResponse', () => {
    it('unwraps Hub envelope with nested data/meta', () => {
      const normalized = normalizeAiSkillsListResponse({
        success: true,
        data: {
          data: [{ id: '550e8400-e29b-41d4-a716-446655440000', title: 'My Skill' }],
          meta: { page: 1, hasNext: false },
        },
      });
      expect(normalized.data).toHaveLength(1);
      expect(normalized.data[0].title).toBe('My Skill');
      expect(normalized.meta.page).toBe(1);
      expect(normalized.meta.hasNext).toBe(false);
    });

    it('accepts a flat array payload', () => {
      const normalized = normalizeAiSkillsListResponse({
        data: [{ id: 'a', title: 'A' }],
      });
      expect(normalized.data).toHaveLength(1);
      expect(normalized.data[0].id).toBe('a');
    });
  });

  describe('mapHubSkillRows', () => {
    it('maps and sorts catalog entries', () => {
      const mapped = mapHubSkillRows([
        { id: '2', title: 'Zebra', description: ' z ', slug: 'zebra' },
        { id: '1', title: 'Alpha' },
        { id: '', title: 'Skipped' },
      ]);
      expect(mapped).toEqual([
        { id: '1', title: 'Alpha', description: undefined, slug: undefined },
        { id: '2', title: 'Zebra', description: 'z', slug: 'zebra' },
      ]);
    });
  });

  describe('resolveExtractedSkillRoot', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-skill-root-'));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('returns extract dir for flat SKILL.md layout', async () => {
      fs.writeFileSync(path.join(tempDir, 'SKILL.md'), '---\nname: flat\ndescription: d\n---\n');
      await expect(resolveExtractedSkillRoot(tempDir)).resolves.toBe(tempDir);
    });

    it('returns nested folder when SKILL.md is nested once', async () => {
      const packDir = path.join(tempDir, 'my-skill');
      fs.mkdirSync(packDir);
      fs.writeFileSync(path.join(packDir, 'SKILL.md'), '---\nname: nested\ndescription: d\n---\n');
      await expect(resolveExtractedSkillRoot(tempDir)).resolves.toBe(packDir);
    });

    it('throws when SKILL.md is missing', async () => {
      await expect(resolveExtractedSkillRoot(tempDir)).rejects.toBeInstanceOf(
        HubSkillsLibraryError
      );
    });
  });

  describe('listAiSkills', () => {
    it('calls Hub list endpoint with bearer token and public tab', async () => {
      let capturedUrl = '';
      let capturedInit: RequestInit | undefined;
      const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedInit = init;
        return new Response(
          JSON.stringify({
            data: {
              data: [{ id: 'skill-1', title: 'Listed' }],
              meta: { page: 1, hasNext: false },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }) as typeof fetch;

      const result = await listAiSkills('token-abc', { page: 2, limit: 10 }, fetchFn);

      expect(result.data).toHaveLength(1);
      expect(capturedUrl).toContain('/api/ai-skills-library');
      expect(capturedUrl).toContain('page=2');
      expect(capturedUrl).toContain('limit=10');
      expect(capturedUrl).toContain('tab=public');
      expect(capturedInit?.headers).toMatchObject({
        Authorization: 'Bearer token-abc',
        Accept: 'application/json',
      });
    });
  });
});
