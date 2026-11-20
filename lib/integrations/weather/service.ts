/** Weather service — reads forecasts through the HA weather.get_forecasts service */
import { haPost } from '@/lib/haClient';
import { logger } from '@/lib/logger';
import type { ForecastType, WeatherForecastEntry } from './types';

type ForecastsByEntity = Record<string, { forecast?: unknown } | undefined>;

/**
 * Extracts the forecast list of one entity from a get_forecasts response. HA answers
 * `{ service_response: { <entity_id>: { forecast } } }` on the REST API; the bare
 * `{ <entity_id>: { forecast } }` form is accepted too.
 *
 * @param response - Body returned by HA.
 * @param entityId - Weather entity that was queried.
 * @returns The forecast entries, or [] when absent.
 */
export function extractForecast(response: unknown, entityId: string): WeatherForecastEntry[] {
    if (typeof response !== 'object' || response === null) return [];
    const body = response as ForecastsByEntity & { service_response?: ForecastsByEntity };
    const forecast = body.service_response?.[entityId]?.forecast ?? body[entityId]?.forecast;
    return Array.isArray(forecast) ? (forecast as WeatherForecastEntry[]) : [];
}

/**
 * Daily or hourly forecast of a weather entity.
 *
 * @param entityId - Validated `weather.*` entity id.
 * @param type - Forecast granularity.
 * @returns ok=true with the entries ([] when HA has none), ok=false when HA fails.
 */
export async function getWeatherForecast(
    entityId: string,
    type: ForecastType,
): Promise<{ ok: true; forecast: WeatherForecastEntry[] } | { ok: false }> {
    try {
        const { data, ok } = await haPost<unknown>(
            '/api/services/weather/get_forecasts?return_response=true',
            { entity_id: entityId, type },
            `forecast:${type}`,
        );
        if (!ok) return { ok: false };
        return { ok: true, forecast: extractForecast(data, entityId) };
    } catch (error) {
        logger.error('[Weather] Forecast call failed', { entityId, type, error: String(error) });
        return { ok: false };
    }
}
