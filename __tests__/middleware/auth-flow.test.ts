/**
 * Tests for the withAuth middleware (auth flow, CORS, rate limiting, network)
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { setMockUser, clearMockUsers, mockPrisma } from '../setup';
import { withAuth } from '@/lib/api-middleware';
import { auth, verifyToken, clerkClient } from '@clerk/nextjs/server';
import { checkRateLimit } from '@/lib/ratelimit';
import { trackSecurityEvent } from '@/lib/security-alerts';
import { ADMIN_USER, LOCAL_ONLY_USER } from '../helpers/test-users';

// lib/user reads the allowlist at import, before this file's imports run
vi.hoisted(() => {
    process.env.ALLOWED_EMAILS = 'family@test.home';
});

afterAll(() => {
    delete process.env.ALLOWED_EMAILS;
});

// Same Clerk mock as setup.ts, plus clerkClient for the email lookup
vi.mock('@clerk/nextjs/server', () => ({
    auth: vi.fn().mockResolvedValue({ userId: null, sessionClaims: null }),
    verifyToken: vi.fn().mockRejectedValue(new Error('mock: no token')),
    clerkClient: vi.fn(),
}));

/** Clerk client whose user has this primary email (null: none). */
function clerkWithPrimaryEmail(email: string | null, status = 'verified') {
    const getUser = vi.fn().mockResolvedValue({
        primaryEmailAddress: email ? { emailAddress: email, verification: { status } } : null,
    });
    return { users: { getUser } } as never;
}

// By default an unknown Clerk account has no verified email: it is refused before any write
beforeEach(() => {
    vi.mocked(clerkClient).mockResolvedValue(clerkWithPrimaryEmail(null));
});

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

    it('returns 403 for an unknown account, without writing it in the database', async () => {
        mockAuth.mockResolvedValue({
            userId: 'clerk_unknown',
            sessionClaims: { email: 'unknown@test.com' },
        } as any);
        // No user set in mock cache → getCachedUser returns null

        const handler = withAuth(testHandler);
        const res = await handler(createRequest(), { params });

        expect(res.status).toBe(403);
        expect(mockPrisma.user.upsert).not.toHaveBeenCalled();
        expect(mockPrisma.user.update).not.toHaveBeenCalled();
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
        // Unknown account: refused before provisioning
        mockAuth.mockResolvedValue({
            userId: 'clerk_unknown',
            sessionClaims: { email: 'unknown@test.com' },
        } as any);

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
        // Unknown Clerk ID with no DB row and no allowed email: refused before provisioning
        mockAuth.mockResolvedValue({ userId: 'clerk_unknown', sessionClaims: { email: 'unknown@test.com' } } as any);

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
            // Other tests rely on unknown users never being provisioned
            mockPrisma.userGroup.findUnique.mockReset();
            mockPrisma.user.upsert.mockReset();
            mockPrisma.user.findFirst.mockReset();
            mockPrisma.user.update.mockReset();
        });

        const provisionedEmail = () => (mockPrisma.user.upsert.mock.calls[0][0] as { create: { email: string } }).create.email;

        const expectNothingWritten = () => {
            expect(mockPrisma.user.upsert).not.toHaveBeenCalled();
            expect(mockPrisma.user.update).not.toHaveBeenCalled();
            expect(mockPrisma.userGroup.create).not.toHaveBeenCalled();
        };

        it('provisions an allowed account with its verified Clerk email, not the token claims', async () => {
            mockAuth.mockResolvedValue({ userId: NEW_ID, sessionClaims: { email: 'claims@test.home' } } as any);
            vi.mocked(clerkClient).mockResolvedValue(clerkWithPrimaryEmail('family@test.home'));

            const res = await withAuth(testHandler)(createRequest(), { params });

            expect(res.status).toBe(200);
            expect(provisionedEmail()).toBe('family@test.home');
        });

        it('refuses an account whose email is not allowed, without writing anything (audit H1)', async () => {
            mockAuth.mockResolvedValue({ userId: NEW_ID, sessionClaims: {} } as any);
            vi.mocked(clerkClient).mockResolvedValue(clerkWithPrimaryEmail('stranger@gmail.example'));

            const res = await withAuth(testHandler)(createRequest(), { params });

            expect(res.status).toBe(403);
            expect((await res.json()).code).toBe('USER_NOT_FOUND');
            expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
            expectNothingWritten();
            expect(trackSecurityEvent).toHaveBeenCalledWith(expect.objectContaining({
                type: 'permission_denied',
                details: 'Account not allowed: stranger@gmail.example',
            }));
            expect(testHandler).not.toHaveBeenCalled();
        });

        it('refuses an allowed email that Clerk has not verified', async () => {
            mockAuth.mockResolvedValue({ userId: NEW_ID, sessionClaims: { email: 'family@test.home' } } as any);
            vi.mocked(clerkClient).mockResolvedValue(clerkWithPrimaryEmail('family@test.home', 'unverified'));

            const res = await withAuth(testHandler)(createRequest(), { params });

            expect(res.status).toBe(403);
            expectNothingWritten();
            expect(trackSecurityEvent).toHaveBeenCalledWith(expect.objectContaining({ details: 'Account without a verified email' }));
        });

        it('answers 503 when Clerk cannot be reached, without writing anything', async () => {
            mockAuth.mockResolvedValue({ userId: NEW_ID, sessionClaims: {} } as any);
            vi.mocked(clerkClient).mockRejectedValue(new Error('down'));

            const res = await withAuth(testHandler)(createRequest(), { params });

            expect(res.status).toBe(503);
            expect((await res.json()).code).toBe('SERVICE_UNAVAILABLE');
            expectNothingWritten();
        });

        it('re-attaches the user already holding this email to the new Clerk id', async () => {
            const existing = { id: 7, clerkId: 'clerk_dev_instance', email: 'Family@test.home', group: 'children', userGroup: { name: 'children', permissions: ['remote'] } };
            mockAuth.mockResolvedValue({ userId: NEW_ID, sessionClaims: {} } as any);
            vi.mocked(clerkClient).mockResolvedValue(clerkWithPrimaryEmail('family@test.home'));
            mockPrisma.user.findFirst.mockResolvedValue(existing as never);
            mockPrisma.user.update.mockResolvedValue({ ...existing, clerkId: NEW_ID } as never);

            const res = await withAuth(testHandler)(createRequest(), { params });

            expect(res.status).toBe(200);
            expect(mockPrisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 7 }, data: { clerkId: NEW_ID } }));
            expect(mockPrisma.user.upsert).not.toHaveBeenCalled();
            expect(testHandler).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
                user: expect.objectContaining({ group: 'children' }),
                userEmail: 'Family@test.home',
            }));
        });

        it('returns USER_NOT_FOUND when the database write fails', async () => {
            mockAuth.mockResolvedValue({ userId: NEW_ID, sessionClaims: {} } as any);
            vi.mocked(clerkClient).mockResolvedValue(clerkWithPrimaryEmail('family@test.home'));
            mockPrisma.user.upsert.mockRejectedValue(new Error('db down'));

            const res = await withAuth(testHandler)(createRequest(), { params });

            expect(res.status).toBe(403);
            expect((await res.json()).code).toBe('USER_NOT_FOUND');
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
