/**
 * Maintenance — tâches périodiques lancées par le check-alerts (seul job planifié chez
 * cron-job.org) : compteurs d'usage de la veille, synchro Enedis toutes les 4 h, purge R2 par jour.
 */
import prisma from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { syncEnedisData } from '@/lib/integrations/enedis';
import { syncDailyUsageIfDue } from '@/lib/integrations/daily-usage';

const HOUR_MS = 60 * 60 * 1000;

/** A task run every `everyMs`; its last attempt is kept in SystemState under `maintenance.<name>`. */
interface PeriodicTask {
    name: 'sync-enedis' | 'cleanup-r2';
    everyMs: number;
    run: () => Promise<unknown>;
}

/** Days of the Enedis sync: yesterday and the day before, in case a reading came late. */
const ENEDIS_SYNC_DAYS = 2;
/** Camera and Petkit images kept in R2. */
const R2_RETENTION_DAYS = 7;

const PERIODIC_TASKS: readonly PeriodicTask[] = [
    { name: 'sync-enedis', everyMs: 4 * HOUR_MS, run: () => syncEnedisData(ENEDIS_SYNC_DAYS) },
    {
        name: 'cleanup-r2',
        everyMs: 24 * HOUR_MS,
        run: async () => {
            const { deleteOldObjects } = await import('@/lib/r2');
            return {
                cameras: await deleteOldObjects('cameras/', R2_RETENTION_DAYS),
                petkit: await deleteOldObjects('petkit/', R2_RETENTION_DAYS),
            };
        },
    },
];

const markerKey = (task: PeriodicTask) => `maintenance.${task.name}`;

/** What one alert check did besides the alerts. */
export interface MaintenanceResult {
    task: 'daily-usage' | PeriodicTask['name'];
    ok: boolean;
    result?: unknown;
}

/**
 * Runs at most one maintenance task, the first one due: the usage counters of the days not done
 * yet, then the Enedis sync, then the R2 purge.
 *
 * WARNING: performance — one task per call, since the alert check shares Vercel's 60 s with it;
 * the check runs every minute, so a task due waits a minute at most. A periodic task's attempt is
 * recorded before it runs: a failing one is retried at its next period, not every minute.
 *
 * @param now - Current instant (tests).
 * @returns The task run, or null when none was due. Never throws.
 */
export async function runDueMaintenance(now = new Date()): Promise<MaintenanceResult | null> {
    const dailyUsage = await syncDailyUsageIfDue(now);
    if (dailyUsage) return { task: 'daily-usage', ok: true, result: dailyUsage };

    try {
        const markers = await prisma.systemState.findMany({
            where: { key: { in: PERIODIC_TASKS.map(markerKey) } },
        });
        const lastRun = new Map(markers.map(m => [m.key, Date.parse(m.value)]));
        const due = PERIODIC_TASKS.find(task => {
            const last = lastRun.get(markerKey(task));
            return last === undefined || Number.isNaN(last) || now.getTime() - last >= task.everyMs;
        });
        if (!due) return null;

        await prisma.systemState.upsert({
            where: { key: markerKey(due) },
            update: { value: now.toISOString() },
            create: { key: markerKey(due), value: now.toISOString() },
        });
        try {
            const result = await due.run();
            logger.info('[Maintenance] Task done', { task: due.name });
            return { task: due.name, ok: true, result };
        } catch (error) {
            logger.error('[Maintenance] Task failed', { task: due.name, error: String(error) });
            return { task: due.name, ok: false };
        }
    } catch (error) {
        logger.error('[Maintenance] Markers unavailable', { error: String(error) });
        return null;
    }
}
