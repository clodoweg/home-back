import { withAuth } from '@/lib/api-middleware';
import { getEnedisData } from '@/lib/integrations/enedis';
import { ApiResponse } from '@/lib/api-response';
import { logger } from '@/lib/logger';
import { parseDateRange } from '@/lib/date-utils';
import { canAccessHistory } from '@/lib/permissions';

export const GET = withAuth(async (request, { user }) => {
    // Check permission
    if (!canAccessHistory(user)) {
        return ApiResponse.forbidden("'history' permission required");
    }

    const { start, end } = parseDateRange(request.url);
    const { searchParams } = new URL(request.url);
    const loadCurveStartStr = searchParams.get('loadCurveStart');
    const loadCurveStart = loadCurveStartStr ? new Date(loadCurveStartStr) : undefined;
    logger.debug(`[Enedis Data Request] Start: ${start?.toISOString()}, End: ${end?.toISOString()}, LoadCurveStart: ${loadCurveStart?.toISOString()}`);

    try {
        const data = await getEnedisData(start, end, loadCurveStart);
        logger.debug(`[Enedis Data Result] Consumption: ${data?.dailyConsumption?.length}, MaxPower: ${data?.dailyMaxPower?.length}, LoadCurve: ${data?.loadCurve?.length}`);
        const response = ApiResponse.success(data);
        // Authenticated response: a shared cache must never serve it to another caller
        response.headers.set('Cache-Control', 'private, no-store');
        return response;
    } catch (error) {
        logger.error('[Enedis] Request failed', { error: String(error) });
        return ApiResponse.serverError();
    }
});
