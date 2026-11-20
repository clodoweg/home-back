/**
 * Unit tests for lib/user-cache.ts
 * Uses the real implementation with mocked Prisma.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.unmock('@/lib/user-cache');

import { getCachedUser, invalidateUserCache } from '@/lib/user-cache';
import { mockPrisma } from '../setup';

const MOCK_USER = {
    id: 1,
    clerkId: 'clerk_abc',
    email: 'test@home.local',
    group: 'user',
    widgetPreferences: {},
    theme: 'dark',
    createdAt: new Date(),
    userGroup: { name: 'user', permissions: ['remote'] },
};

describe('user-cache', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Ensure clean cache state by invalidating between tests
        invalidateUserCache(MOCK_USER.clerkId);
    });

    afterEach(() => {
        vi.useRealTimers();
        invalidateUserCache(MOCK_USER.clerkId);
    });

    describe('getCachedUser', () => {
        it('returns null when user does not exist in DB', async () => {
            mockPrisma.user.findUnique.mockResolvedValue(null);

            const result = await getCachedUser('unknown_clerk_id');

            expect(result).toBeNull();
            expect(mockPrisma.user.findUnique).toHaveBeenCalledTimes(1);
        });

        it('fetches user from DB on cache miss and returns it', async () => {
            mockPrisma.user.findUnique.mockResolvedValue(MOCK_USER as any);

            const result = await getCachedUser(MOCK_USER.clerkId);

            expect(result).toEqual(MOCK_USER);
            expect(mockPrisma.user.findUnique).toHaveBeenCalledTimes(1);
        });

        it('returns cached user on second call without hitting DB again', async () => {
            mockPrisma.user.findUnique.mockResolvedValue(MOCK_USER as any);

            await getCachedUser(MOCK_USER.clerkId); // cache miss → DB call
            await getCachedUser(MOCK_USER.clerkId); // cache hit → no DB call

            expect(mockPrisma.user.findUnique).toHaveBeenCalledTimes(1);
        });

        it('re-fetches from DB after TTL expires (5 minutes)', async () => {
            vi.useFakeTimers();
            mockPrisma.user.findUnique.mockResolvedValue(MOCK_USER as any);

            await getCachedUser(MOCK_USER.clerkId); // first fetch
            expect(mockPrisma.user.findUnique).toHaveBeenCalledTimes(1);

            // Advance past the 5-minute TTL
            vi.advanceTimersByTime(5 * 60 * 1000 + 1);

            await getCachedUser(MOCK_USER.clerkId); // should re-fetch
            expect(mockPrisma.user.findUnique).toHaveBeenCalledTimes(2);
        });

        it('does not re-fetch if TTL has not expired', async () => {
            vi.useFakeTimers();
            mockPrisma.user.findUnique.mockResolvedValue(MOCK_USER as any);

            await getCachedUser(MOCK_USER.clerkId);
            vi.advanceTimersByTime(4 * 60 * 1000); // 4 min, still fresh

            await getCachedUser(MOCK_USER.clerkId);
            expect(mockPrisma.user.findUnique).toHaveBeenCalledTimes(1);
        });
    });

    describe('invalidateUserCache', () => {
        it('forces a DB re-fetch after invalidation', async () => {
            mockPrisma.user.findUnique.mockResolvedValue(MOCK_USER as any);

            await getCachedUser(MOCK_USER.clerkId); // populate cache
            invalidateUserCache(MOCK_USER.clerkId); // evict
            await getCachedUser(MOCK_USER.clerkId); // should hit DB again

            expect(mockPrisma.user.findUnique).toHaveBeenCalledTimes(2);
        });

        it('is a no-op for a clerkId not in cache', () => {
            expect(() => invalidateUserCache('nonexistent_id')).not.toThrow();
        });
    });
});
