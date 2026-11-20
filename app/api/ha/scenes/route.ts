/**
 * Home Assistant Scenes Endpoint
 * Fetches all scenes from HA and extracts their brightness attributes.
 */

import { withAuth } from '@/lib/api-middleware';
import { ApiResponse } from '@/lib/api-response';
import { getCachedStates } from '@/lib/ha-states-cache';

export const GET = withAuth(async () => {
    const { data, ok } = await getCachedStates();

    if (!ok || !Array.isArray(data)) {
        return ApiResponse.error('Failed to fetch from Home Assistant', 502);
    }

    // Map scene entity_id to its configuration (currently only brightness)
    const sceneConfigs: Record<string, { brightness: number | null }> = {};

    data.filter(e => e.entity_id.startsWith('scene.')).forEach(scene => {
        const brightness = scene.attributes?.brightness;
        sceneConfigs[scene.entity_id] = {
            brightness: typeof brightness === 'number' ? brightness : null
        };
    });

    const response = ApiResponse.success(sceneConfigs);
    // Authenticated response: a shared cache must never serve it to another caller
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
});
