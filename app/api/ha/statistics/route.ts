/** HA statistics — statistiques long terme du recorder (onglet Historique du front) */
import { withAuth } from '@/lib/api-middleware';
import { ApiResponse } from '@/lib/api-response';
import { getStatistics, statisticsQuerySchema } from '@/lib/integrations/ha-statistics';
import { logger } from '@/lib/logger';
import { canAccessHistory } from '@/lib/permissions';
import { validateQuery } from '@/lib/validators';

/**
 * GET /api/ha/statistics?statistic_ids=sensor.a,sensor.b&start=ISO&end=ISO&period=hour|day|week|month&types=mean,min,max,change
 * — the HA recorder's long-term statistics, kept by HA beyond the history purge. Example:
 * `{ "sensor.salon_temperature": [{ "start": "2026-11-01T00:00:00.000Z", "mean": 20.4, "min": 19.8, "max": 21.1 }] }`.
 *
 * @returns 200 with rows per statistic id, 400 on an invalid query or a window too long for the
 * period, 403 without the history right, 502 when HA fails (whatever HA says).
 */
export const GET = withAuth(async (request, { user, userEmail }) => {
    if (!canAccessHistory(user)) {
        logger.security('Blocked statistics access', { userEmail });
        return ApiResponse.forbidden('Forbidden: You do not have permission to view history.');
    }

    const validation = validateQuery(new URL(request.url).searchParams, statisticsQuerySchema);
    if (!validation.success) return validation.error;

    try {
        const statistics = await getStatistics(validation.data);
        const response = ApiResponse.success(statistics);
        // Authenticated response: a shared cache must never serve it to another caller
        response.headers.set('Cache-Control', 'private, no-store');
        return response;
    } catch (error) {
        // HA's own error never reaches the client: a refused HA token is not a Clerk session issue
        logger.error('Error in /api/ha/statistics', { error: String(error) });
        return ApiResponse.error('Home Assistant API error', 502);
    }
});
