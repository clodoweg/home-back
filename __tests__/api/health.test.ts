/**
 * Tests for GET /api/health
 */
import { describe, it, expect } from 'vitest';
import { GET } from '@/app/api/health/route';

describe('GET /api/health', () => {
    it('returns 200 healthy when env vars are set', async () => {
        const response = await GET();
        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data.status).toBe('healthy');
        expect(data.checks.homeAssistant).toBe(true);
        expect(data.checks.timestamp).toBeDefined();
    });

    it('returns correct version field', async () => {
        const response = await GET();
        const data = await response.json();
        // In tests, VERCEL_GIT_COMMIT_SHA is not set, so it should be 'local'
        expect(data.version).toBe('local');
    });
});
