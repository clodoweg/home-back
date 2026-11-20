/** History usage — compteurs d'usage quotidiens enregistrés (onglet Historique du front) */
import { z } from 'zod';
import { withAuth } from '@/lib/api-middleware';
import { ApiResponse } from '@/lib/api-response';
import { getDailyUsage } from '@/lib/integrations/daily-usage';
import { logger } from '@/lib/logger';
import { canAccessCameras, canAccessHistory } from '@/lib/permissions';
import { validateQuery } from '@/lib/validators';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 3 * 366;
const daySchema = z.iso.date();

const usageQuerySchema = z
    .object({ start: daySchema, end: daySchema })
    .refine(({ start, end }) => start <= end, { message: 'start must precede end', path: ['start'] })
    .refine(({ start, end }) => new Date(end).getTime() - new Date(start).getTime() <= MAX_RANGE_DAYS * DAY_MS, {
        message: 'Range too long',
        path: ['end'],
    });

/**
 * GET /api/history/usage?start=yyyy-MM-dd&end=yyyy-MM-dd — usage counters per day, e.g.
 * `{ "washer_cycles": [{ "date": "2026-11-18", "value": 1 }], "light_hours:light.salon": [...] }`.
 * Camera detections (`motion:*`) need the cameras right, like the cameras themselves.
 *
 * @returns 200 with series per metric, 400 on an invalid range, 403 without the history right.
 */
export const GET = withAuth(async (request, { user, userEmail }) => {
    if (!canAccessHistory(user)) {
        logger.security('Blocked usage history access', { userEmail });
        return ApiResponse.forbidden('Forbidden: You do not have permission to view history.');
    }

    const validation = validateQuery(new URL(request.url).searchParams, usageQuerySchema);
    if (!validation.success) return validation.error;

    try {
        const cameras = canAccessCameras(user);
        const series = await getDailyUsage(validation.data.start, validation.data.end, metric => cameras || !metric.startsWith('motion:'));
        const response = ApiResponse.success(series);
        // Authenticated response: a shared cache must never serve it to another caller
        response.headers.set('Cache-Control', 'private, no-store');
        return response;
    } catch (error) {
        logger.error('Error in /api/history/usage', { error: String(error) });
        return ApiResponse.serverError();
    }
});
