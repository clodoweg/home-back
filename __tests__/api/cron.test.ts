import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GET } from '@/app/api/cron/route';
import { mockPrisma } from '../setup';
import { resetApiEnabledCache } from '@/lib/settings';
import { syncEnedisData } from '@/lib/integrations/enedis';
import { runAlertCheck } from '@/lib/integrations/alerts';
import { deleteOldObjects } from '@/lib/r2';

vi.mock('@/lib/integrations/enedis', () => ({ syncEnedisData: vi.fn() }));
vi.mock('@/lib/integrations/alerts', () => ({ runAlertCheck: vi.fn() }));
vi.mock('@/lib/r2', () => ({ deleteOldObjects: vi.fn() }));
vi.mock('@/lib/integrations/daily-usage', () => ({ syncDailyUsage: vi.fn(), MAX_CATCH_UP_DAYS: 9 }));
vi.mock('@/lib/integrations/maintenance', () => ({ runDueMaintenance: vi.fn() }));
const { syncDailyUsage } = await import('@/lib/integrations/daily-usage');
const { runDueMaintenance } = await import('@/lib/integrations/maintenance');

const SECRET = 'cron_test_secret';

const cron = (query: string, authorization: string | null = `Bearer ${SECRET}`) =>
    GET(new Request(`http://localhost:3000/api/cron${query}`, { headers: authorization ? { authorization } : {} }));

describe('GET /api/cron', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetApiEnabledCache();
        vi.stubEnv('CRON_SECRET', SECRET);
        mockPrisma.systemSettings.findUnique.mockResolvedValue({ id: 1, apiEnabled: true } as never);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    describe('authentication', () => {
        it('refuses everything when CRON_SECRET is not configured', async () => {
            vi.stubEnv('CRON_SECRET', '');
            const res = await cron('?task=check-alerts');
            expect(res.status).toBe(500);
            expect(runAlertCheck).not.toHaveBeenCalled();
        });

        it.each([null, 'Bearer wrong', SECRET, `bearer ${SECRET}`, `Bearer ${SECRET}x`])('returns 401 for authorization %j', async (authorization) => {
            const res = await cron('?task=check-alerts', authorization);
            expect(res.status).toBe(401);
            expect(runAlertCheck).not.toHaveBeenCalled();
        });
    });

    it('runs the alert check', async () => {
        vi.mocked(runAlertCheck).mockResolvedValue({ ok: true, eventsDetected: 2, adminsNotified: 1, notificationsStored: 2 });

        const res = await cron('?task=check-alerts');

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ task: 'check-alerts', eventsDetected: 2, notificationsStored: 2 });
    });

    it('runs the maintenance task due after the alert check', async () => {
        vi.mocked(runAlertCheck).mockResolvedValue({ ok: true, eventsDetected: 0, adminsNotified: 0, notificationsStored: 0 });
        vi.mocked(runDueMaintenance).mockResolvedValueOnce({ task: 'sync-enedis', ok: true });

        const res = await cron('?task=check-alerts');

        expect((await res.json()).maintenance).toEqual({ task: 'sync-enedis', ok: true });
        const again = await cron('?task=check-alerts');
        expect(await again.json()).not.toHaveProperty('maintenance');
    });

    it('computes the usage counters on demand', async () => {
        vi.mocked(syncDailyUsage).mockResolvedValue({ days: ['2026-11-18'], rows: 3 });

        const res = await cron('?task=daily-usage');

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ task: 'daily-usage', result: { rows: 3 } });
    });

    it('catches every missing day up on demand, and names the failing step', async () => {
        vi.mocked(syncDailyUsage).mockRejectedValue(new Error('HA history unavailable for 2026-11-17 (0 day(s) saved before)'));

        const res = await cron('?task=daily-usage');

        expect(vi.mocked(syncDailyUsage).mock.calls[0].slice(1)).toEqual([9, false]);
        expect(res.status).toBe(500);
        expect(await res.json()).toMatchObject({ error: 'Daily usage failed', details: 'HA history unavailable for 2026-11-17 (0 day(s) saved before)' });
    });

    it('recomputes the days HA still has with redo=1', async () => {
        vi.mocked(syncDailyUsage).mockResolvedValue({ days: [], rows: 0 });
        await cron('?task=daily-usage&redo=1');
        expect(vi.mocked(syncDailyUsage).mock.calls[0].slice(1)).toEqual([9, true]);
    });

    it('reports a non-Error failure of the daily usage', async () => {
        vi.mocked(syncDailyUsage).mockRejectedValue('db down');
        const res = await cron('?task=daily-usage');
        expect((await res.json()).details).toBe('db down');
    });

    it('cleans camera and Petkit objects older than 7 days', async () => {
        vi.mocked(deleteOldObjects).mockResolvedValue({ deleted: 3, errors: 0 });

        const res = await cron('?task=cleanup-r2');

        expect(res.status).toBe(200);
        expect(deleteOldObjects).toHaveBeenCalledWith('cameras/', 7);
        expect(deleteOldObjects).toHaveBeenCalledWith('petkit/', 7);
        expect((await res.json()).results.cameras).toEqual({ deleted: 3, errors: 0 });
    });

    it.each([
        ['', 1],
        ['&days=14', 14],
        ['&days=0', 1],
        ['&days=999', 30],
        ['&days=abc', 1],
        ['&days=7.9', 7],
    ])('syncs Enedis with days clamped to 1–30 (%s → %i)', async (query, expectedDays) => {
        vi.mocked(syncEnedisData).mockResolvedValue({ success: true });

        const res = await cron(`?task=sync-enedis${query}`);

        expect(res.status).toBe(200);
        expect(syncEnedisData).toHaveBeenCalledWith(expectedDays);
    });

    it('returns 400 for an unknown or missing task', async () => {
        expect((await cron('?task=drop-db')).status).toBe(400);
        expect((await cron('')).status).toBe(400);
    });

    it('returns a generic 500 when a task throws', async () => {
        vi.mocked(runAlertCheck).mockRejectedValue(new Error('HA token expired: abc123'));

        const res = await cron('?task=check-alerts');

        expect(res.status).toBe(500);
        expect(JSON.stringify(await res.json())).not.toContain('abc123');
    });
});
