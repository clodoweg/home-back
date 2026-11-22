/**
 * Tests for GET /api/health
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { GET } from '@/app/api/health/route';

describe('GET /api/health', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('returns 200 healthy when env vars are set', async () => {
        const response = await GET();
        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data.status).toBe('healthy');
        expect(data.checks.homeAssistant).toBe(true);
        expect(data.checks.timestamp).toBeDefined();
    });

    it('does not disclose the deployed commit (audit L3)', async () => {
        vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '0123456789abcdef');

        const data = await (await GET()).json();

        expect(data).not.toHaveProperty('version');
        expect(JSON.stringify(data)).not.toContain('0123456');
    });
});
