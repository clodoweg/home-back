/** Arlo snapshot — demande une nouvelle capture à une caméra Arlo */
import { withAuth } from '@/lib/api-middleware';
import { ApiResponse } from '@/lib/api-response';
import { canActOnHome } from '@/lib/permissions';
import { logger } from '@/lib/logger';
import { triggerArloSnapshot } from '@/lib/integrations/arlo';
import { arloCameraEntityIdPattern } from '@/lib/validators';

/**
 * POST /api/arlo/snapshot/[entity_id] — triggers the capture; the front refreshes the
 * states a few seconds later to get the new thumbnail.
 *
 * A capture is an action on the house: admin group only (`canActOnHome`), even for a group holding
 * the cameras right, which only lets it see the pictures.
 *
 * @returns 200 when HA accepted the request, 400 for a non-Arlo camera, 403 outside the admin group.
 */
export const POST = withAuth<{ entity_id: string }>(async (_request, { params, user }) => {
    const { entity_id } = await params;

    if (!arloCameraEntityIdPattern.test(entity_id)) {
        return ApiResponse.badRequest('Invalid entity_id, must be camera.aarlo_*');
    }

    if (!canActOnHome(user)) {
        logger.security('Blocked Arlo snapshot', { userEmail: user.email, entityId: entity_id });
        return ApiResponse.forbidden('Forbidden: Group restriction');
    }

    try {
        if (!(await triggerArloSnapshot(entity_id, 'snapshot'))) {
            return ApiResponse.error('Failed to trigger snapshot', 502);
        }
        return ApiResponse.success({
            success: true,
            message: 'Snapshot requested',
            entity_id,
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        logger.error('[Arlo] Snapshot error', { entityId: entity_id, error: String(error) });
        return ApiResponse.serverError();
    }
});
