import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET as healthGET } from '@/app/api/health/route';
import { GET as cronGET } from '@/app/api/cron/route';
import { withAuth } from '@/lib/api-middleware';
import { NextResponse } from 'next/server';
import { mockPrisma } from '../setup';
import { resetApiEnabledCache } from '@/lib/settings';

// Mock Enedis env vars to avoid startup warnings
process.env.ENEDIS_PDL = '123456789';
process.env.ENEDIS_TOKEN = 'test-token';

describe('System Maintenance (API ON/OFF)', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        // Reset the in-memory cache so each test gets fresh DB lookups
        resetApiEnabledCache();
        // Default: API is ON in singleton
        mockPrisma.systemSettings.findUnique.mockResolvedValue({
            id: 1,
            apiEnabled: true,
            updatedAt: new Date()
        } as any);
    });

    it('should allow requests when API is ON', async () => {
        const response = await healthGET();
        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data.status).toBe('healthy');
    });

    it('should block public health requests when API is OFF', async () => {
        // Turn API OFF in mock singleton
        mockPrisma.systemSettings.findUnique.mockResolvedValue({
            id: 1,
            apiEnabled: false,
            updatedAt: new Date()
        } as any);

        const response = await healthGET();
        expect(response.status).toBe(503);

        const data = await response.json();
        expect(data.status).toBe('maintenance');
        expect(data.message).toContain('API disabled');
    });

    it('should block cron requests when API is OFF', async () => {
        // Turn API OFF in mock singleton
        mockPrisma.systemSettings.findUnique.mockResolvedValue({
            id: 1,
            apiEnabled: false,
            updatedAt: new Date()
        } as any);

        process.env.CRON_SECRET = 'cron_test_secret';
        const response = await cronGET(new Request('http://localhost/api/cron', {
            headers: { authorization: 'Bearer cron_test_secret' },
        }));
        expect(response.status).toBe(503);

        const data = await response.json();
        expect(data.error).toContain('API disabled');
    });

    it('checks the cron secret before querying the database', async () => {
        process.env.CRON_SECRET = 'cron_test_secret';

        const response = await cronGET(new Request('http://localhost/api/cron'));

        expect(response.status).toBe(401);
        expect(mockPrisma.systemSettings.findUnique).not.toHaveBeenCalled();
    });

    it('should block authenticated routes via withAuth when API is OFF', async () => {
        const { auth } = await import('@clerk/nextjs/server');
        // Setup auth mock to return a user
        vi.mocked(auth).mockResolvedValue({ userId: 'test-user', sessionClaims: { email: 'test@example.com' } } as any);

        // Turn API OFF in mock singleton
        mockPrisma.systemSettings.findUnique.mockResolvedValue({
            id: 1,
            apiEnabled: false,
            updatedAt: new Date()
        } as any);

        // Set mock user in cache (required by withAuth)
        const { setMockUser } = await import('../setup');
        setMockUser('test-user', { id: 1, clerkId: 'test-user', email: 'test@example.com', group: 'admin' });

        const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }));
        const authenticatedHandler = withAuth(handler);

        const request = new Request('http://localhost/api/user/me', {
            method: 'GET',
            headers: {
                'x-request-id': 'test-req',
            }
        });

        const response = await authenticatedHandler(request, { params: Promise.resolve({}) });

        expect(response.status).toBe(503);
        const data = await response.json();
        expect(data.error).toContain('API disabled');
        expect(handler).not.toHaveBeenCalled();
    });
});
