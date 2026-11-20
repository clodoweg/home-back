import { withAuth } from '@/lib/api-middleware';
import { ApiResponse } from '@/lib/api-response';
import { getCachedStates } from '@/lib/ha-states-cache';
import { canSeeCameraEntities } from '@/lib/permissions';
import { logger } from '@/lib/logger';

/**
 * GET /api/ha/states — every HA state, camera entities hidden from groups not allowed to see them.
 *
 * @returns 200 with the states, 502 when HA fails.
 */
export const GET = withAuth(async (_request, { user }) => {
    const { data, ok } = await getCachedStates();

    if (!ok || !Array.isArray(data)) {
        logger.error('Failed to fetch or invalid response from Home Assistant');
        return ApiResponse.error('Failed to fetch from Home Assistant', 502);
    }

    const filteredData = canSeeCameraEntities(user)
        ? data
        : data.filter(entity => !entity.entity_id.startsWith('camera.'));

    const response = ApiResponse.success(filteredData);
    // The body depends on the caller's group: no shared cache may ever store it
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
});

