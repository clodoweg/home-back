/** HA history — proxies validated history reads to Home Assistant */
import { withAuth } from '@/lib/api-middleware';
import { haFetch } from '@/lib/haClient';
import { ApiResponse } from '@/lib/api-response';
import { canAccessHistory } from '@/lib/permissions';
import { buildHistoryPath } from '@/lib/ha-paths';
import { sanitizeHAHistory } from '@/lib/ha-state-filter';
import { logger } from '@/lib/logger';

/**
 * GET /api/ha/history/[[...slug]] — 200 with the HA history without its sensitive attributes (a
 * device tracker's history is a GPS trail), 400 on invalid parameters, 403 without the history
 * right, 502 when HA fails (whatever HA status).
 *
 * Supports two formats:
 * 1. Simplified format (no slug):
 *    GET /api/ha/history?entity_id=sensor.xxx&start_time=ISO&end_time=ISO
 * 
 * 2. Full format (with slug):
 *    GET /api/ha/history/period/2026-01-29T21:50:00.000Z?filter_entity_id=sensor.xxx&end_time=ISO
 */
export const GET = withAuth<{ slug?: string[] }>(async (request, { params, user }) => {
    try {
        const url = new URL(request.url);
        const slugParams = (await params).slug || [];

        // 1. Permission Check
        if (!canAccessHistory(user)) {
            logger.security('Blocked history access', { userEmail: user.email });
            return ApiResponse.forbidden('Forbidden: You do not have permission to view history.');
        }

        // 2. HA path rebuilt from validated parts only (never the raw slug or query)
        const haPath = buildHistoryPath(slugParams, url.searchParams);
        if (!haPath) {
            return ApiResponse.badRequest('Invalid history parameters');
        }

        // 3. Proxy to Home Assistant
        const { data, ok } = await haFetch(haPath, { label: 'history' });

        // Never relay the HA status: a 401/403 from HA (invalid HA token) would look like an
        // expired Clerk session to the front. The path is built by us, so an HA 404 is an
        // upstream fault too. haFetch already logged the HA status.
        if (!ok) {
            return ApiResponse.error('Home Assistant API error', 502);
        }

        return ApiResponse.success(sanitizeHAHistory(data));

    } catch (error) {
        logger.error('Error in /api/ha/history', { error: String(error) });
        return ApiResponse.serverError();
    }
});

