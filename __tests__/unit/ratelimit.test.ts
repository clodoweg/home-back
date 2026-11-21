/**
 * Unit tests for lib/ratelimit.ts
 * Upstash when configured, the in-memory window otherwise or when Upstash fails: never unlimited.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.unmock('@/lib/ratelimit');

const { upstashLimit } = vi.hoisted(() => ({ upstashLimit: vi.fn() }));

// Mock Upstash so the module can be imported without real credentials
vi.mock('@upstash/ratelimit', () => ({
    Ratelimit: class {
        static slidingWindow() { return {}; }
        limit = upstashLimit;
    },
}));

vi.mock('@upstash/redis', () => ({
    Redis: class {},
}));

import { checkRateLimit, MemoryRateLimiter, type RateLimiter } from '@/lib/ratelimit';
import { logger } from '@/lib/logger';

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);

describe('MemoryRateLimiter', () => {
    it('allows the quota of the window, then refuses', () => {
        const limiter = new MemoryRateLimiter(2, 60_000);

        expect(limiter.limit('1.2.3.4', NOW)).toEqual({ success: true, remaining: 1, reset: NOW + 60_000 });
        expect(limiter.limit('1.2.3.4', NOW + 1)).toMatchObject({ success: true, remaining: 0 });
        expect(limiter.limit('1.2.3.4', NOW + 2)).toMatchObject({ success: false, remaining: 0 });
    });

    it('counts each identifier on its own', () => {
        const limiter = new MemoryRateLimiter(1, 60_000);

        expect(limiter.limit('1.2.3.4', NOW).success).toBe(true);
        expect(limiter.limit('5.6.7.8', NOW).success).toBe(true);
        expect(limiter.limit('1.2.3.4', NOW).success).toBe(false);
    });

    it('starts a new window once the previous one is over', () => {
        const limiter = new MemoryRateLimiter(1, 60_000);
        limiter.limit('1.2.3.4', NOW);

        expect(limiter.limit('1.2.3.4', NOW + 59_999).success).toBe(false);
        expect(limiter.limit('1.2.3.4', NOW + 60_000)).toEqual({ success: true, remaining: 0, reset: NOW + 120_000 });
    });

    it('drops expired windows first when the map is full', () => {
        const limiter = new MemoryRateLimiter(1, 60_000, 2);
        limiter.limit('old', NOW);
        limiter.limit('recent', NOW + 30_000);

        limiter.limit('new', NOW + 61_000);

        // 'recent' was kept: it is still limited
        expect(limiter.limit('recent', NOW + 61_000).success).toBe(false);
    });

    it('drops the oldest window when none has expired', () => {
        const limiter = new MemoryRateLimiter(1, 60_000, 2);
        limiter.limit('first', NOW);
        limiter.limit('second', NOW);

        limiter.limit('third', NOW);

        // 'first' was forgotten, so it starts a fresh window; 'third' is still counted
        expect(limiter.limit('first', NOW).success).toBe(true);
        expect(limiter.limit('third', NOW).success).toBe(false);
    });

    it('uses the current time by default', () => {
        expect(new MemoryRateLimiter(1, 60_000).limit('1.2.3.4').success).toBe(true);
    });
});

describe('checkRateLimit', () => {
    const memoryOnly = (requests: number): RateLimiter => ({ upstash: null, memory: new MemoryRateLimiter(requests, 60_000) });
    const withUpstash = (requests: number): RateLimiter => ({
        upstash: { limit: upstashLimit } as unknown as RateLimiter['upstash'],
        memory: new MemoryRateLimiter(requests, 60_000),
    });

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('applies the in-memory window when Upstash is not configured', async () => {
        const limiter = memoryOnly(1);

        expect((await checkRateLimit(limiter, '127.0.0.1')).success).toBe(true);
        expect((await checkRateLimit(limiter, '127.0.0.1')).success).toBe(false);
    });

    it('returns the Upstash verdict when Upstash answers', async () => {
        upstashLimit.mockResolvedValue({ success: false, remaining: 0, reset: 9999 });

        const result = await checkRateLimit(withUpstash(100), '192.168.1.10');

        expect(upstashLimit).toHaveBeenCalledWith('192.168.1.10');
        expect(result).toEqual({ success: false, remaining: 0, reset: 9999 });
    });

    it('falls back on the in-memory window when Upstash fails (never unlimited, never a 500)', async () => {
        upstashLimit.mockRejectedValue(new Error('Redis unavailable'));
        const limiter = withUpstash(1);

        expect((await checkRateLimit(limiter, '10.0.0.1')).success).toBe(true);
        expect((await checkRateLimit(limiter, '10.0.0.1')).success).toBe(false);
        expect(logger.error).toHaveBeenCalledWith(
            'Rate limit check failed on Upstash, in-memory limit applied',
            expect.objectContaining({ error: 'Error: Redis unavailable' }),
        );
    });
});

describe('limiters configuration', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    /** Loads fresh copies of the module and of the mocked logger under the given environment. */
    async function loadModule(env: Record<string, string>) {
        for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
        vi.resetModules();
        const ratelimit = await import('@/lib/ratelimit');
        const { logger: freshLogger } = await import('@/lib/logger');
        return { ...ratelimit, freshLogger };
    }

    it('uses Upstash when it is configured', async () => {
        const { apiRatelimit, strictRatelimit, imageRatelimit, freshLogger } = await loadModule({
            NODE_ENV: 'production',
            UPSTASH_REDIS_REST_URL: 'https://upstash.invalid',
            UPSTASH_REDIS_REST_TOKEN: 'token',
            ENABLE_UPSTASH_REDIS: 'true',
        });

        expect([apiRatelimit, strictRatelimit, imageRatelimit].every(limiter => limiter.upstash !== null)).toBe(true);
        expect(freshLogger.error).not.toHaveBeenCalled();
    });

    it('reports in production that only in-memory limits apply without Upstash', async () => {
        const { apiRatelimit, freshLogger } = await loadModule({
            NODE_ENV: 'production',
            UPSTASH_REDIS_REST_URL: '',
            UPSTASH_REDIS_REST_TOKEN: '',
        });

        expect(apiRatelimit.upstash).toBeNull();
        expect(freshLogger.error).toHaveBeenCalledWith(
            'Upstash Redis is not configured: rate limits only apply per server instance (in memory)',
        );
    });

    it('stays quiet without Upstash outside production', async () => {
        const { freshLogger } = await loadModule({ NODE_ENV: 'test', ENABLE_UPSTASH_REDIS: 'false' });

        expect(freshLogger.error).not.toHaveBeenCalled();
    });
});
