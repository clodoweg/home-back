/**
 * Unit tests for lib/ratelimit.ts
 * Tests checkRateLimit behavior with and without a configured limiter.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.unmock('@/lib/ratelimit');

// Mock Upstash so the module can be imported without real credentials
vi.mock('@upstash/ratelimit', () => ({
    Ratelimit: class {
        constructor() {}
        static slidingWindow() { return {}; }
        async limit() { return { success: true, remaining: 10, reset: Date.now() + 60000 }; }
    },
}));

vi.mock('@upstash/redis', () => ({
    Redis: class {
        constructor() {}
    },
}));

import { checkRateLimit } from '@/lib/ratelimit';

describe('ratelimit', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('checkRateLimit', () => {
        it('returns { success: true } immediately when limiter is null (rate limiting disabled)', async () => {
            const result = await checkRateLimit(null, '127.0.0.1');

            expect(result.success).toBe(true);
            expect(result.remaining).toBeUndefined();
        });

        it('calls limiter.limit with the identifier and returns its result', async () => {
            const mockLimiter = {
                limit: vi.fn().mockResolvedValue({ success: true, remaining: 42, reset: 9999 }),
            };

            const result = await checkRateLimit(mockLimiter as any, '192.168.1.10');

            expect(mockLimiter.limit).toHaveBeenCalledWith('192.168.1.10');
            expect(result.success).toBe(true);
            expect(result.remaining).toBe(42);
            expect(result.reset).toBe(9999);
        });

        it('returns { success: false } when limiter blocks the request', async () => {
            const mockLimiter = {
                limit: vi.fn().mockResolvedValue({ success: false, remaining: 0, reset: 9999 }),
            };

            const result = await checkRateLimit(mockLimiter as any, '10.0.0.1');

            expect(result.success).toBe(false);
            expect(result.remaining).toBe(0);
        });

        it('fails open when the limiter throws (Redis outage must not cause a 500)', async () => {
            const mockLimiter = {
                limit: vi.fn().mockRejectedValue(new Error('Redis unavailable')),
            };

            await expect(checkRateLimit(mockLimiter as any, '127.0.0.1')).resolves.toEqual({ success: true });
        });
    });
});
