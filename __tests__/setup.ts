/**
 * Global test setup — mocks external dependencies so tests run without
 * network, database, or third-party services.
 */
import { vi, beforeEach } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import { PrismaClient } from '@/lib/generated/prisma/client';

// ── Mock Prisma (inline to avoid path resolution issues) ──────────────────────
export const mockPrisma = mockDeep<PrismaClient>();

vi.mock('@/lib/prisma', () => ({
    default: mockPrisma,
    prisma: mockPrisma,
    CONNECTION_TIMEOUT_MS: 10_000,
}));

// ── Mock User Cache (uses Prisma internally) ─────────────────────────────────
const userCacheStore = new Map<string, any>();

vi.mock('@/lib/user-cache', () => ({
    getCachedUser: vi.fn(async (clerkId: string) => {
        return userCacheStore.get(clerkId) || null;
    }),
    invalidateUserCache: vi.fn(),
}));

/** Set a user in the mock cache (call in tests before withAuth) */
export function setMockUser(clerkId: string, user: any) {
    userCacheStore.set(clerkId, user);
}

/** Clear the mock user cache */
export function clearMockUsers() {
    userCacheStore.clear();
}

// ── Mock Clerk auth ───────────────────────────────────────────────────────────
vi.mock('@clerk/nextjs/server', () => ({
    auth: vi.fn().mockResolvedValue({ userId: null, sessionClaims: null }),
    verifyToken: vi.fn().mockRejectedValue(new Error('mock: no token')),
    // An unknown Clerk account has no verified email by default: it is never provisioned
    clerkClient: vi.fn().mockResolvedValue({ users: { getUser: vi.fn().mockResolvedValue({ primaryEmailAddress: null }) } }),
}));

// ── Mock next/headers ─────────────────────────────────────────────────────────
const DEFAULT_REQUEST_HEADERS: Record<string, string> = {
    'x-request-id': 'test-req-id',
    'origin': 'http://localhost:3000',
    'cf-connecting-ip': '127.0.0.1',
    'x-forwarded-for': '127.0.0.1',
    'user-agent': 'vitest-test',
};

const defaultHeaders = () => ({ get: vi.fn((key: string) => DEFAULT_REQUEST_HEADERS[key] || null) });

vi.mock('next/headers', () => ({
    headers: vi.fn(async () => defaultHeaders()),
}));

// ── Guards shared by every test ──────────────────────────────────────────────
// A test that overrides the request headers must not leak them into the next one,
// and an unmocked fetch must fail loudly instead of reaching the real network.
beforeEach(async () => {
    const { headers } = await import('next/headers');
    vi.mocked(headers).mockImplementation((async () => defaultHeaders()) as never);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Unmocked fetch in test'))));
});

// ── Mock Rate Limiter (always allow) ──────────────────────────────────────────
vi.mock('@/lib/ratelimit', () => ({
    apiRatelimit: {},
    strictRatelimit: {},
    imageRatelimit: {},
    checkRateLimit: vi.fn().mockResolvedValue({ success: true, remaining: 10 }),
}));

// ── Mock Logger (silent) ──────────────────────────────────────────────────────
vi.mock('@/lib/logger', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        apiRequest: vi.fn(),
        apiResponse: vi.fn(),
        haCall: vi.fn(),
        security: vi.fn(),
        rateLimit: vi.fn(),
    },
}));

// JSON calls are mocked; binary fetches keep their real implementation on top of the
// stubbed global fetch, so image routes are tested through their HTTP exchanges
vi.mock('@/lib/haClient', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/haClient')>()),
    haFetch: vi.fn(),
    haGet: vi.fn(),
    haPost: vi.fn(),
}));

// ── Mock Security Alerts (no-op) ──────────────────────────────────────────────
vi.mock('@/lib/security-alerts', () => ({
    trackSecurityEvent: vi.fn(),
}));

// ── Mock DNS (no real lookup of the home DDNS name) ──────────────────────────
// isOnHomeNetwork resolves the DDNS name for non-LAN IPs: without this mock, tests
// would query the real DNS. Tests that need resolved addresses override it.
vi.mock('dns', () => {
    const promises = { resolve4: vi.fn().mockResolvedValue([]), resolve6: vi.fn().mockResolvedValue([]) };
    return { promises, default: { promises } };
});

// ── Env variables ─────────────────────────────────────────────────────────────
process.env.HA_BASE_URL = 'http://ha-mock.local:8123';
process.env.HA_ACCESS_TOKEN = 'test-ha-token';
process.env.CLERK_SECRET_KEY = 'test-clerk-secret';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.CRON_SECRET = 'test_secret';
// Fictitious identifiers: the real ones live only in Vercel (personal data, public repository)
process.env.SUEZ_COUNTER_ID = '1234567890';
process.env.PETKIT_DEVICE_ID = '100000001';
