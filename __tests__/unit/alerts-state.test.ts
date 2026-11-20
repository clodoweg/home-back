import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockPrisma } from '../setup';
import { loadSnapshot, saveSnapshot } from '@/lib/integrations/alerts/snapshot';

const redisSet = vi.fn();

vi.mock('@upstash/redis', () => ({
    Redis: vi.fn(function Redis() {
        return { set: redisSet };
    }),
}));

/** throttle.ts picks Redis or memory at import: load a fresh copy per scenario. */
async function loadShouldEmit(env: Record<string, string> = {}) {
    const config = { UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '', ENABLE_UPSTASH_REDIS: '', ...env };
    for (const [key, value] of Object.entries(config)) vi.stubEnv(key, value);
    vi.resetModules();
    return (await import('@/lib/integrations/alerts/throttle')).shouldEmit;
}

describe('alert throttle', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
    });

    it('lets one alert per user and key through every 5 minutes (memory fallback)', async () => {
        vi.useFakeTimers({ now: new Date(Date.UTC(2026, 9, 22, 12)) });
        const shouldEmit = await loadShouldEmit();

        expect(await shouldEmit(1, 'lights:Salon:on')).toBe(true);
        expect(await shouldEmit(1, 'lights:Salon:on')).toBe(false);
        expect(await shouldEmit(2, 'lights:Salon:on')).toBe(true);
        expect(await shouldEmit(1, 'lights:Salon:off')).toBe(true);

        vi.advanceTimersByTime(5 * 60 * 1000);
        expect(await shouldEmit(1, 'lights:Salon:on')).toBe(true);
    });

    it('uses SET NX with a 5-minute TTL in Redis', async () => {
        const shouldEmit = await loadShouldEmit({ UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 't' });
        redisSet.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);

        expect(await shouldEmit(1, 'alarm')).toBe(true);
        expect(await shouldEmit(1, 'alarm')).toBe(false);
        expect(redisSet).toHaveBeenCalledWith('alert:1:alarm', '1', { nx: true, ex: 300 });
    });
});

describe('alert snapshot persistence', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('loads the stored snapshot, or an empty one when missing or corrupted', async () => {
        mockPrisma.systemState.findUnique.mockResolvedValueOnce({ key: 'alerts:lastSnapshot', value: '{"lights":{"Salon":true}}' } as never);
        expect(await loadSnapshot()).toEqual({ lights: { Salon: true } });

        mockPrisma.systemState.findUnique.mockResolvedValueOnce(null);
        expect(await loadSnapshot()).toEqual({});

        mockPrisma.systemState.findUnique.mockResolvedValueOnce({ key: 'alerts:lastSnapshot', value: '{broken' } as never);
        expect(await loadSnapshot()).toEqual({});
    });

    it('upserts the snapshot as JSON under a single key', async () => {
        await saveSnapshot({ lights: { Salon: false } });

        expect(mockPrisma.systemState.upsert).toHaveBeenCalledWith({
            where: { key: 'alerts:lastSnapshot' },
            update: { value: '{"lights":{"Salon":false}}' },
            create: { key: 'alerts:lastSnapshot', value: '{"lights":{"Salon":false}}' },
        });
    });
});
