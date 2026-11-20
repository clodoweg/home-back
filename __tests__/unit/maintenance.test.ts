import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockPrisma } from '../setup';
import { runDueMaintenance } from '@/lib/integrations/maintenance';
import { syncEnedisData } from '@/lib/integrations/enedis';
import { syncDailyUsageIfDue } from '@/lib/integrations/daily-usage';
import { deleteOldObjects } from '@/lib/r2';

vi.mock('@/lib/integrations/enedis', () => ({ syncEnedisData: vi.fn() }));
vi.mock('@/lib/integrations/daily-usage', () => ({ syncDailyUsageIfDue: vi.fn() }));
vi.mock('@/lib/r2', () => ({ deleteOldObjects: vi.fn() }));

const NOW = new Date('2026-11-20T09:00:00Z');
const marker = (name: string, iso: string) => ({ key: `maintenance.${name}`, value: iso });

describe('runDueMaintenance', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(syncDailyUsageIfDue).mockResolvedValue(null);
        mockPrisma.systemState.findMany.mockResolvedValue([]);
        mockPrisma.systemState.upsert.mockResolvedValue({} as never);
        vi.mocked(syncEnedisData).mockResolvedValue({ ok: true } as never);
        vi.mocked(deleteOldObjects).mockResolvedValue({ deleted: 2, errors: 0 });
    });

    it('computes the usage counters first, and nothing else in that run', async () => {
        vi.mocked(syncDailyUsageIfDue).mockResolvedValue({ days: ['2026-11-19'], rows: 10 });
        expect(await runDueMaintenance(NOW)).toEqual({ task: 'daily-usage', ok: true, result: { days: ['2026-11-19'], rows: 10 } });
        expect(syncEnedisData).not.toHaveBeenCalled();
    });

    it('syncs Enedis every 4 hours, recording the attempt before it runs', async () => {
        mockPrisma.systemState.findMany.mockResolvedValue([marker('sync-enedis', '2026-11-20T04:59:00Z')] as never);

        const result = await runDueMaintenance(NOW);

        expect(result).toEqual({ task: 'sync-enedis', ok: true, result: { ok: true } });
        expect(syncEnedisData).toHaveBeenCalledWith(2);
        expect(mockPrisma.systemState.upsert).toHaveBeenCalledWith({
            where: { key: 'maintenance.sync-enedis' },
            update: { value: NOW.toISOString() },
            create: { key: 'maintenance.sync-enedis', value: NOW.toISOString() },
        });
    });

    it('purges the R2 images once a day when Enedis is not due', async () => {
        mockPrisma.systemState.findMany.mockResolvedValue([
            marker('sync-enedis', '2026-11-20T08:00:00Z'),
            marker('cleanup-r2', 'not a date'),
        ] as never);

        const result = await runDueMaintenance(NOW);

        expect(result?.task).toBe('cleanup-r2');
        expect(deleteOldObjects).toHaveBeenCalledWith('cameras/', 7);
        expect(deleteOldObjects).toHaveBeenCalledWith('petkit/', 7);
        expect(result?.result).toEqual({ cameras: { deleted: 2, errors: 0 }, petkit: { deleted: 2, errors: 0 } });
    });

    it('does nothing when every task ran recently', async () => {
        mockPrisma.systemState.findMany.mockResolvedValue([
            marker('sync-enedis', '2026-11-20T08:00:00Z'),
            marker('cleanup-r2', '2026-11-19T12:00:00Z'),
        ] as never);
        expect(await runDueMaintenance(NOW)).toBeNull();
        expect(mockPrisma.systemState.upsert).not.toHaveBeenCalled();
    });

    it('never throws: a failing task or unreadable markers are logged', async () => {
        vi.mocked(syncEnedisData).mockRejectedValue(new Error('Enedis down'));
        expect(await runDueMaintenance(NOW)).toEqual({ task: 'sync-enedis', ok: false });

        mockPrisma.systemState.findMany.mockRejectedValue(new Error('db down'));
        expect(await runDueMaintenance(NOW)).toBeNull();
    });
});
