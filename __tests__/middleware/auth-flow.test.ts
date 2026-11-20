/**
 * Tests for the withAuth middleware (auth flow, CORS, rate limiting, network)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setMockUser, clearMockUsers, mockPrisma } from '../setup';
import { withAuth } from '@/lib/api-middleware';
import { auth, verifyToken, clerkClient } from '@clerk/nextjs/server';
import { checkRateLimit } from '@/lib/ratelimit';
import { ADMIN_USER, LOCAL_ONLY_USER } from '../helpers/test-users';

// Same Clerk mock as setup.ts, plus clerkClient for the email lookup
vi.mock('@clerk/nextjs/server', () => ({
    auth: vi.fn().mockResolvedValue({ userId: null, sessionClaims: null }),
    verifyToken: vi.fn().mockRejectedValue(new Error('mock: no token')),
    clerkClient: vi.fn(),
}));

const mockAuth = vi.mocked(auth);
const mockCheckRateLimit = vi.mocked(checkRateLimit);

// Simple handler that returns 200
const testHandler = vi.fn().mockImplementation(async (_req, { user }) => {
    const { NextResponse } = await import('next/server');
    return NextResponse.json({ ok: true, email: user.email });
});

function createRequest(method = 'GET', url = 'http://localhost:3000/api/test') {
    return new Request(url, { method, headers: { Authorization: 'Bearer test-token' } });
}

const params = Promise.resolve({});

describe('withAuth — Authentication', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
        mockCheckRateLimit.mockResolvedValue({ success: true, remaining: 10 } as any);
    });

    it('returns 401 when no userId', async () => {
        mockAuth.mockResolvedValue({ userId: null, sessionClaims: null } as any);
        vi.mocked(verifyToken).mockRejectedValue(new Error('no token'));

        const handler = withAuth(testHandler);
        const res = await handler(createRequest(), { params });

        expect(res.status).toBe(401);
    });

    it('returns 403 when user not in DB', async () => {
        mockAuth.mockResolvedValue({
            userId: 'clerk_unknown',
            sessionClaims: { email: 'unknown@test.com' },
        } as any);
        // Provisioning of an unknown user fails (DB error)
        mockPrisma.user.upsert.mockRejectedValueOnce(new Error('db down'));
        // No user set in mock cache → getCachedUser returns null

        const handler = withAuth(testHandler);
        const res = await handler(createRequest(), { params });

        expect(res.status).toBe(403);
    });

    it('returns 200 for authenticated admin', async () => {
        mockAuth.mockResolvedValue({
            userId: ADMIN_USER.clerkId,
            sessionClaims: { email: ADMIN_USER.email },
        } as any);
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);

        const handler = withAuth(testHandler);
        const res = await handler(createRequest(), { params });

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.email).toBe(ADMIN_USER.email);
    });

    it('falls back to verifyToken when auth() returns no userId', async () => {
        mockAuth.mockResolvedValue({ userId: null, sessionClaims: null } as any);
        vi.mocked(verifyToken).mockResolvedValue({
            sub: ADMIN_USER.clerkId,
            email: ADMIN_USER.email,
        } as any);
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);

        const handler = withAuth(testHandler);
        const res = await handler(createRequest(), { params });

        expect(res.status).toBe(200);
    });
});

describe('withAuth — CORS', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
        mockCheckRateLimit.mockResolvedValue({ success: true, remaining: 10 } as any);
    });

    it('sends no CORS header at all for an origin outside the allowlist', async () => {
        mockAuth.mockResolvedValue({ userId: null, sessionClaims: null } as any);
        vi.mocked(verifyToken).mockRejectedValue(new Error('no token'));

        const { headers } = await import('next/headers');
        vi.mocked(headers).mockResolvedValue({
            get: vi.fn((key: string) => (key === 'origin' ? 'https://evil.example' : null)),
        } as any);

        const res = await withAuth(testHandler)(new Request('http://localhost:3000/api/test'), { params });

        expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });

    it('applies CORS headers to 401 Unauthorized responses', async () => {
        mockAuth.mockResolvedValue({ userId: null, sessionClaims: null } as any);
        vi.mocked(verifyToken).mockRejectedValue(new Error('no token'));

        const { headers } = await import('next/headers');
        vi.mocked(headers).mockResolvedValue({
            get: vi.fn((key: string) => {
                if (key === 'origin') return 'http://localhost:5173';
                return null;
            }),
        } as any);

        const handler = withAuth(testHandler);
        const req = new Request('http://localhost:3000/api/test', { method: 'GET' });
        const res = await handler(req, { params });

        expect(res.status).toBe(401);
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    });

    it('applies CORS headers to 403 Forbidden responses', async () => {
        mockAuth.mockResolvedValue({
            userId: 'clerk_unknown',
            sessionClaims: { email: 'unknown@test.com' },
        } as any);
        // Provisioning of an unknown user fails (DB error)
        mockPrisma.user.upsert.mockRejectedValueOnce(new Error('db down'));

        const { headers } = await import('next/headers');
        vi.mocked(headers).mockResolvedValue({
            get: vi.fn((key: string) => {
                if (key === 'origin') return 'http://localhost:5173';
                return null;
            }),
        } as any);

        const handler = withAuth(testHandler);
        const req = new Request('http://localhost:3000/api/test', { method: 'GET' });
        const res = await handler(req, { params });

        expect(res.status).toBe(403);
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    });
});

describe('withAuth — Rate Limiting', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
    });

    it('returns 429 when rate limited', async () => {
        mockCheckRateLimit.mockResolvedValue({ success: false, remaining: 0 } as any);

        const handler = withAuth(testHandler);
        const res = await handler(createRequest(), { params });

        expect(res.status).toBe(429);
    });
});

describe('withAuth — Network Restriction', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
        mockCheckRateLimit.mockResolvedValue({ success: true, remaining: 10 } as any);
    });

    it('blocks remote access for user without remote permission', async () => {
        mockAuth.mockResolvedValue({
            userId: LOCAL_ONLY_USER.clerkId,
            sessionClaims: { email: LOCAL_ONLY_USER.email },
        } as any);
        setMockUser(LOCAL_ONLY_USER.clerkId, LOCAL_ONLY_USER);

        // Mock headers to return an external IP
        const { headers } = await import('next/headers');
        vi.mocked(headers).mockResolvedValue({
            get: vi.fn((key: string) => {
                if (key === 'cf-connecting-ip') return '203.0.113.50';
                if (key === 'x-forwarded-for') return '203.0.113.50';
                if (key === 'x-request-id') return 'test-req';
                if (key === 'origin') return 'http://localhost:3000';
                return null;
            }),
        } as any);

        const handler = withAuth(testHandler);
        const req = createRequest();
        const res = await handler(req, { params });

        expect(res.status).toBe(403);
    });
});

describe('withAuth — client IP behind Cloudflare (S05)', () => {
    const ORIGIN_SECRET = 'cf_origin_test_secret';

    async function mockRequestHeaders(values: Record<string, string>) {
        const { headers } = await import('next/headers');
        vi.mocked(headers).mockResolvedValue({ get: vi.fn((key: string) => values[key] ?? null) } as any);
    }

    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
        mockCheckRateLimit.mockResolvedValue({ success: true, remaining: 10 } as any);
        mockAuth.mockResolvedValue({
            userId: LOCAL_ONLY_USER.clerkId,
            sessionClaims: { email: LOCAL_ONLY_USER.email },
        } as any);
        setMockUser(LOCAL_ONLY_USER.clerkId, LOCAL_ONLY_USER);
        process.env.CF_ORIGIN_SECRET = ORIGIN_SECRET;
    });

    afterEach(() => {
        delete process.env.CF_ORIGIN_SECRET;
    });

    it('refuses a home IP forged in cf-connecting-ip on a direct call to the origin', async () => {
        await mockRequestHeaders({ 'cf-connecting-ip': '192.168.1.10', 'x-real-ip': '203.0.113.50' });

        const res = await withAuth(testHandler)(createRequest(), { params });

        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.code).toBe('IP_RESTRICTED');
        expect(JSON.stringify(body)).not.toContain('203.0.113.50');
        expect(JSON.stringify(body)).not.toContain('192.168.1.10');
    });

    it('refuses a forged cf-connecting-ip with a wrong origin secret', async () => {
        await mockRequestHeaders({ 'cf-connecting-ip': '192.168.1.10', 'x-origin-secret': 'guess', 'x-real-ip': '203.0.113.50' });

        const res = await withAuth(testHandler)(createRequest(), { params });

        expect(res.status).toBe(403);
    });

    it('trusts cf-connecting-ip when Cloudflare injected the origin secret', async () => {
        await mockRequestHeaders({ 'cf-connecting-ip': '192.168.1.10', 'x-origin-secret': ORIGIN_SECRET, 'x-real-ip': '172.70.1.1' });

        const res = await withAuth(testHandler)(createRequest(), { params });

        expect(res.status).toBe(200);
    });

    it('rate-limits on the trusted IP, not on the forged one', async () => {
        await mockRequestHeaders({ 'cf-connecting-ip': '10.9.8.7', 'x-real-ip': '203.0.113.50' });

        await withAuth(testHandler)(createRequest(), { params });

        expect(mockCheckRateLimit).toHaveBeenCalledWith(expect.anything(), '203.0.113.50');
    });
});

describe('withAuth — error contract and token transport', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
        mockCheckRateLimit.mockResolvedValue({ success: true, remaining: 10 } as any);
    });

    it('refuses a JWT passed in the query string (S10)', async () => {
        mockAuth.mockResolvedValue({ userId: null, sessionClaims: null } as any);
        vi.mocked(verifyToken).mockResolvedValue({ sub: ADMIN_USER.clerkId } as any);
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);

        const req = new Request('http://localhost:3000/api/test?token=valid.jwt.token');
        const res = await withAuth(testHandler)(req, { params });

        expect(res.status).toBe(401);
        expect(verifyToken).not.toHaveBeenCalled();
    });

    it('verifies Bearer tokens against the authorized parties (S13)', async () => {
        mockAuth.mockResolvedValue({ userId: null, sessionClaims: null } as any);
        vi.mocked(verifyToken).mockResolvedValue({ sub: ADMIN_USER.clerkId, email: ADMIN_USER.email } as any);
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);

        const res = await withAuth(testHandler)(createRequest(), { params });

        expect(res.status).toBe(200);
        expect(verifyToken).toHaveBeenCalledWith(
            'test-token',
            expect.objectContaining({ authorizedParties: expect.arrayContaining(['https://home.psaltery.org']) }),
        );
    });

    it('returns 429 with the RATE_LIMITED code', async () => {
        mockCheckRateLimit.mockResolvedValue({ success: false, remaining: 0 } as any);

        const res = await withAuth(testHandler)(createRequest(), { params });

        expect(res.status).toBe(429);
        expect((await res.json()).code).toBe('RATE_LIMITED');
        expect(res.headers.get('Retry-After')).toBe('60');
    });

    it('puts USER_NOT_FOUND in the code field the front reads (F12)', async () => {
        // Unknown Clerk ID with no DB row: auto-provisioning fails on the mocked Prisma
        mockAuth.mockResolvedValue({ userId: 'clerk_unknown', sessionClaims: { email: 'unknown@test.com' } } as any);
        mockPrisma.user.upsert.mockRejectedValueOnce(new Error('db down'));

        const res = await withAuth(testHandler)(createRequest(), { params });

        expect(res.status).toBe(403);
        const body = await res.json();
        expect(body.code).toBe('USER_NOT_FOUND');
        expect(body.details).toBeUndefined();
    });

    it('replaces an unsafe client request ID instead of reflecting it (S21)', async () => {
        mockAuth.mockResolvedValue({ userId: ADMIN_USER.clerkId, sessionClaims: { email: ADMIN_USER.email } } as any);
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
        const { headers } = await import('next/headers');
        vi.mocked(headers).mockResolvedValue({
            get: vi.fn((key: string) => (key === 'x-request-id' ? 'abc\nFAKE LOG LINE' : key === 'x-real-ip' ? '127.0.0.1' : null)),
        } as any);

        const res = await withAuth(testHandler)(createRequest(), { params });

        expect(res.headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{8}$/);
    });
});

describe('withAuth — Clerk fallbacks and handler errors', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
        mockCheckRateLimit.mockResolvedValue({ success: true, remaining: 10 } as any);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('falls back on the Bearer token when clerkMiddleware was not detected', async () => {
        mockAuth.mockRejectedValue(new Error('clerkMiddleware() was not run'));
        vi.mocked(verifyToken).mockResolvedValue({ sub: ADMIN_USER.clerkId, email: ADMIN_USER.email } as any);
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);

        const res = await withAuth(testHandler)(createRequest(), { params });

        expect(res.status).toBe(200);
    });

    it('returns a generic 500 when auth() fails for another reason', async () => {
        mockAuth.mockRejectedValue(new Error('Clerk API unreachable'));

        const res = await withAuth(testHandler)(createRequest(), { params });

        expect(res.status).toBe(500);
        expect(JSON.stringify(await res.json())).not.toContain('unreachable');
    });

    it('still verifies the token when CLERK_SECRET_KEY is missing (Clerk then rejects it)', async () => {
        vi.stubEnv('CLERK_SECRET_KEY', '');
        mockAuth.mockResolvedValue({ userId: null, sessionClaims: null } as any);
        vi.mocked(verifyToken).mockRejectedValue(new Error('missing secret'));

        const res = await withAuth(testHandler)(createRequest(), { params });

        expect(res.status).toBe(401);
        expect(verifyToken).toHaveBeenCalledWith('test-token', expect.objectContaining({ secretKey: '' }));
    });

    it('returns 401 when the verified claims carry no subject', async () => {
        mockAuth.mockResolvedValue({ userId: null, sessionClaims: null } as any);
        vi.mocked(verifyToken).mockResolvedValue({ iss: 'clerk' } as any);

        expect((await withAuth(testHandler)(createRequest(), { params })).status).toBe(401);
    });

    it('uses the cached user email without calling Clerk (P08)', async () => {
        mockAuth.mockResolvedValue({ userId: ADMIN_USER.clerkId, sessionClaims: {} } as any);
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);

        const res = await withAuth(testHandler)(createRequest(), { params });

        expect(res.status).toBe(200);
        expect(clerkClient).not.toHaveBeenCalled();
        expect(testHandler).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userEmail: ADMIN_USER.email }));
    });

    describe('provisioning a new user', () => {
        const NEW_ID = 'clerk_new_user';

        beforeEach(() => {
            mockPrisma.userGroup.findUnique.mockResolvedValue({ name: 'user', permissions: ['remote'] } as never);
            mockPrisma.user.upsert.mockImplementation((async (args: { create: Record<string, unknown> }) =>
                ({ ...args.create, id: 9, userGroup: { name: 'user', permissions: ['remote'] } })) as never);
        });

        afterEach(() => {
            // Other tests rely on provisioning failing for unknown users
            mockPrisma.userGroup.findUnique.mockReset();
            mockPrisma.user.upsert.mockReset();
        });

        const provisionedEmail = () => (mockPrisma.user.upsert.mock.calls[0][0] as { create: { email: string } }).create.email;

        it('asks Clerk for the email when the token has none', async () => {
            mockAuth.mockResolvedValue({ userId: NEW_ID, sessionClaims: {} } as any);
            const getUser = vi.fn().mockResolvedValue({ primaryEmailAddress: { emailAddress: 'from-clerk@test.home' } });
            vi.mocked(clerkClient).mockResolvedValue({ users: { getUser } } as any);

            const res = await withAuth(testHandler)(createRequest(), { params });

            expect(res.status).toBe(200);
            expect(getUser).toHaveBeenCalledWith(NEW_ID);
            expect(provisionedEmail()).toBe('from-clerk@test.home');
        });

        it('prefers the claims email, then the first Clerk address', async () => {
            mockAuth.mockResolvedValue({ userId: NEW_ID, sessionClaims: { primary_email: 'claims@test.home' } } as any);
            await withAuth(testHandler)(createRequest(), { params });
            expect(clerkClient).not.toHaveBeenCalled();
            expect(provisionedEmail()).toBe('claims@test.home');

            mockPrisma.user.upsert.mockClear();
            mockAuth.mockResolvedValue({ userId: NEW_ID, sessionClaims: {} } as any);
            const getUser = vi.fn().mockResolvedValue({ emailAddresses: [{ emailAddress: 'second@test.home' }] });
            vi.mocked(clerkClient).mockResolvedValue({ users: { getUser } } as any);
            await withAuth(testHandler)(createRequest(), { params });
            expect(provisionedEmail()).toBe('second@test.home');

            mockPrisma.user.upsert.mockClear();
            getUser.mockResolvedValue({ emailAddresses: [] });
            await withAuth(testHandler)(createRequest(), { params });
            expect(provisionedEmail()).toBe(`user-${NEW_ID}`);
        });

        it('falls back on a synthetic email when Clerk cannot be reached', async () => {
            mockAuth.mockResolvedValue({ userId: NEW_ID, sessionClaims: {} } as any);
            vi.mocked(clerkClient).mockRejectedValue(new Error('down'));

            await withAuth(testHandler)(createRequest(), { params });

            expect(provisionedEmail()).toBe(`user-${NEW_ID}`);
        });
    });

    it('limits sensitive routes per user, whatever the IP (S18)', async () => {
        mockAuth.mockResolvedValue({ userId: ADMIN_USER.clerkId, sessionClaims: { email: ADMIN_USER.email } } as any);
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
        mockCheckRateLimit.mockImplementation((async (_limiter: unknown, key: string) => ({ success: !key.startsWith('user:') })) as any);

        const sensitive = await withAuth(testHandler)(createRequest('POST', 'http://localhost:3000/api/ha/call'), { params });
        const regular = await withAuth(testHandler)(createRequest('GET', 'http://localhost:3000/api/ha/states'), { params });

        expect(sensitive.status).toBe(429);
        expect(mockCheckRateLimit).toHaveBeenCalledWith(expect.anything(), `user:${ADMIN_USER.clerkId}`);
        expect(regular.status).toBe(200);
    });

    it.each([
        ['quota exceeded for this project', 503, 'SERVICE_UNAVAILABLE'],
        ['too many connections', 503, 'SERVICE_UNAVAILABLE'],
        ['TypeError: x is undefined', 500, undefined],
    ])('maps a handler error "%s" to %i without leaking it', async (message, status, code) => {
        mockAuth.mockResolvedValue({ userId: ADMIN_USER.clerkId, sessionClaims: { email: ADMIN_USER.email } } as any);
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
        const failing = vi.fn().mockRejectedValue(new Error(message));

        const res = await withAuth(failing)(createRequest(), { params });

        expect(res.status).toBe(status);
        const body = await res.json();
        expect(body.code).toBe(code);
        expect(JSON.stringify(body)).not.toContain(message);
    });
});
