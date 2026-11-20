/** HA metadata — area, floor and device model of the dashboard entities (light, sensor, climate) */
import { withAuth } from '@/lib/api-middleware';
import { ApiResponse } from '@/lib/api-response';
import { getEntityMetadata } from '@/lib/integrations/ha-metadata';

/**
 * GET /api/ha/metadata — renders a fixed server-side template (no client input).
 * Same rights as GET /api/ha/states: any authenticated user.
 *
 * Body: `Record<entity_id, { area: string; floor: string; model: string }>`, empty strings when
 * HA knows nothing, e.g. `{ "light.salon": { "area": "Salon", "floor": "RDC", "model": "Hue" } }`.
 *
 * @returns 200 with the metadata, 502 when HA fails or renders invalid JSON.
 */
export const GET = withAuth(async () => {
    const result = await getEntityMetadata();
    if (!result.ok) {
        return ApiResponse.error('Failed to fetch metadata from Home Assistant', 502);
    }

    const response = ApiResponse.success(result.data);
    // Authenticated response: a shared cache must never serve it to another caller
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
});
