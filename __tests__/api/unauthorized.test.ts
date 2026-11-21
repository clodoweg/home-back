import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET as getMe } from '@/app/api/user/me/route';
import { auth, verifyToken } from '@clerk/nextjs/server';
import { clearMockUsers, setMockUser } from '../setup';
import { headers } from 'next/headers';

vi.mock('@clerk/nextjs/server', () => ({
    auth: vi.fn(),
    verifyToken: vi.fn(),
    // The unknown account has no verified email: it is refused before provisioning
    clerkClient: vi.fn().mockResolvedValue({ users: { getUser: vi.fn().mockResolvedValue({ primaryEmailAddress: null }) } }),
}));

vi.mock('next/headers', () => ({
    headers: vi.fn(),
}));

describe('Authentication & Authorization (401/403)', () => {
    const mockAuth = vi.mocked(auth);
    const mockHeaders = vi.mocked(headers);

    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
        mockHeaders.mockResolvedValue({
            get: vi.fn((key: string) => {
                if (key === 'x-request-id') return 'test-id';
                if (key === 'cf-connecting-ip') return '1.2.3.4';
                return null;
            }),
        } as any);
    });

    it('returns 401 if no user is authenticated (auth() returns null)', async () => {
        mockAuth.mockResolvedValue({ userId: null, sessionClaims: null } as any);

        const req = new Request('http://localhost:3000/api/user/me');
        const res = await getMe(req, { params: Promise.resolve({}) });

        expect(res.status).toBe(401);
    });

    it('returns 401 if token verification fails during manual fallback', async () => {
        mockAuth.mockResolvedValue({ userId: null, sessionClaims: null } as any);
        vi.mocked(verifyToken).mockRejectedValue(new Error('Invalid token'));

        const req = new Request('http://localhost:3000/api/user/me', {
            headers: { 'Authorization': 'Bearer invalid-token' }
        });
        const res = await getMe(req, { params: Promise.resolve({}) });

        expect(res.status).toBe(401);
    });

    it('returns 403 if user is authenticated by Clerk but not in DB', async () => {
        mockAuth.mockResolvedValue({ userId: 'user_unknown', sessionClaims: { email: 'unknown@example.com' } } as any);
        // DB is mocked via setup.ts getCachedUser which returns null if not set via setMockUser

        const req = new Request('http://localhost:3000/api/user/me');
        const res = await getMe(req, { params: Promise.resolve({}) });

        expect(res.status).toBe(403);
        const data = await res.json();
        expect(data.error).toBe('Utilisateur non autorisé');
    });

    it('returns 200 if user is authenticated and in DB', async () => {
        const userId = 'user_authorized';
        mockAuth.mockResolvedValue({ userId, sessionClaims: { email: 'authorized@example.com' } } as any);

        setMockUser(userId, {
            id: 'db_id',
            clerkId: userId,
            email: 'authorized@example.com',
            group: 'admin',
            userGroup: { name: 'admin', permissions: ['remote'] }
        });

        const req = new Request('http://localhost:3000/api/user/me');
        const res = await getMe(req, { params: Promise.resolve({}) });

        expect(res.status).toBe(200);
    });
});
