/**
 * GET /api/cron — scheduled tasks, called by cron-job.org (only check-alerts is scheduled).
 *
 * Supported tasks (via ?task= query param):
 *  - sync-enedis  : pull latest Enedis consumption into the DB
 *  - cleanup-r2   : delete old Cloudflare R2 objects (cameras/ + petkit/)
 *  - check-alerts : detect HA state transitions and notify the admins (bell and Web Push); then the maintenance
 *                   task due (usage counters, Enedis sync every 4 h, R2 purge daily). The only
 *                   job scheduled at cron-job.org; the other tasks stay callable by hand.
 *  - daily-usage  : compute the usage counters of the past days (History tab of the front);
 *                   `&redo=1` recomputes the last 9 days
 *
 * Protected by CRON_SECRET to prevent unauthorized access.
 */

import { ApiResponse } from '@/lib/api-response';
import { logger } from '@/lib/logger';
import { syncEnedisData } from '@/lib/integrations/enedis';
import { runAlertCheck } from '@/lib/integrations/alerts';
import { MAX_CATCH_UP_DAYS, syncDailyUsage } from '@/lib/integrations/daily-usage';
import { runDueMaintenance } from '@/lib/integrations/maintenance';
import { isApiEnabled } from '@/lib/settings';
import { safeCompare } from '@/lib/secure-compare';

export const dynamic = 'force-dynamic';
// WARNING: Hobby caps functions at 60 s without Fluid compute. The alert check may chain a
// 4-second Arlo capture and several HA calls (10 s timeout each).
export const maxDuration = 60;

/**
 * WARNING: public route (no withAuth), protected by the CRON_SECRET bearer, checked
 * before anything else so an anonymous caller cannot trigger a database query.
 *
 * @param request - Incoming request with `Authorization: Bearer <CRON_SECRET>` and `?task=`.
 * @returns The task result, 401 without the secret, 503 when the API is disabled.
 */
export async function GET(request: Request) {
    const authHeader = request.headers.get('authorization') || '';
    const cronSecret = process.env.CRON_SECRET;

    if (!cronSecret) {
        logger.error('[Cron] CRON_SECRET is not configured — refusing request');
        return ApiResponse.error('Server misconfigured', 500);
    }

    if (!safeCompare(authHeader, `Bearer ${cronSecret}`)) {
        logger.warn('[Cron] Unauthorized cron request');
        return ApiResponse.error('Unauthorized', 401);
    }

    const apiEnabled = await isApiEnabled();
    if (!apiEnabled) {
        return ApiResponse.error('API disabled by system settings', 503);
    }

    const { searchParams } = new URL(request.url);
    const task = searchParams.get('task');

    try {
        if (task === 'cleanup-r2') {
            const { deleteOldObjects } = await import('@/lib/r2');
            const cameraCleanup = await deleteOldObjects('cameras/', 7);
            const petkitCleanup = await deleteOldObjects('petkit/', 7);

            return ApiResponse.success({
                ok: true,
                task: 'cleanup-r2',
                timestamp: new Date().toISOString(),
                results: {
                    cameras: cameraCleanup,
                    petkit: petkitCleanup,
                },
            });
        }

        if (task === 'check-alerts') {
            const result = await runAlertCheck();
            // The alert check, called every minute, is the only scheduled job: it also runs the
            // maintenance task due (usage counters, Enedis sync, R2 purge). Never throws.
            const maintenance = await runDueMaintenance();
            return ApiResponse.success({
                task: 'check-alerts',
                timestamp: new Date().toISOString(),
                ...result,
                ...(maintenance ? { maintenance } : {}),
            });
        }

        if (task === 'daily-usage') {
            // Called by hand to catch up or diagnose: every missing day at once, and the failing
            // step in the answer (the route is behind CRON_SECRET; no secret is in the message).
            // `&redo=1` recomputes the days HA still has, e.g. after a new counter.
            let result;
            try {
                result = await syncDailyUsage(new Date(), MAX_CATCH_UP_DAYS, searchParams.get('redo') === '1');
            } catch (error) {
                logger.error('[Cron] daily-usage failed', { error: String(error) });
                return ApiResponse.error('Daily usage failed', 500, error instanceof Error ? error.message : String(error));
            }
            return ApiResponse.success({
                ok: true,
                task: 'daily-usage',
                timestamp: new Date().toISOString(),
                result,
            });
        }

        if (task === 'sync-enedis') {
            const requestedDays = Number(searchParams.get('days') || '1');
            const days = Number.isFinite(requestedDays) ? Math.max(1, Math.min(30, Math.trunc(requestedDays))) : 1;
            const syncResult = await syncEnedisData(days);
            return ApiResponse.success({
                ok: true,
                task: 'sync-enedis',
                timestamp: new Date().toISOString(),
                result: syncResult,
            });
        }

        return ApiResponse.error('Unknown or missing task', 400);
    } catch (error) {
        logger.error(`[Cron] Failed task: ${task}`, { error: String(error) });
        return ApiResponse.error('Cron job failed', 500);
    }
}
