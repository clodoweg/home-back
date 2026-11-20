/** HA forecast — daily or hourly forecast of a weather entity */
import { withAuth } from '@/lib/api-middleware';
import { ApiResponse } from '@/lib/api-response';
import { getWeatherForecast } from '@/lib/integrations/weather';
import { logger } from '@/lib/logger';
import { canCallHAService } from '@/lib/permissions';
import { forecastQuerySchema, validateQuery } from '@/lib/validators';

/**
 * GET /api/ha/forecast?entity_id=weather.xxx&type=daily|hourly — calls `weather.get_forecasts`
 * and returns the forecast array itself (`[]` when HA has none), e.g.
 * `[{ "datetime": "2026-10-26T11:00:00+00:00", "condition": "sunny", "temperature": 18, "templow": 9 }]`.
 * Entries are relayed as HA sends them (fields depend on the weather integration).
 *
 * @returns 200 with the array, 400 on an invalid query, 403 when the entity is refused, 502 when HA fails.
 */
export const GET = withAuth(async (request, { user, userEmail }) => {
    const validation = validateQuery(new URL(request.url).searchParams, forecastQuerySchema);
    if (!validation.success) return validation.error;

    const { entity_id, type } = validation.data;

    // Same entity check as a get_forecasts call through POST /api/ha/call
    if (!canCallHAService(user, 'weather', entity_id)) {
        logger.security('Blocked weather forecast', { userEmail, entity_id });
        return ApiResponse.forbidden('Forbidden: You do not have permission for this entity');
    }

    const result = await getWeatherForecast(entity_id, type);
    if (!result.ok) {
        return ApiResponse.error('Failed to fetch forecast from Home Assistant', 502);
    }

    const response = ApiResponse.success(result.forecast);
    // Authenticated response: a shared cache must never serve it to another caller
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
});
