import { withAuth } from '@/lib/api-middleware';
import { triggerFeederManual } from '@/lib/integrations/petkit';
import { ApiResponse } from '@/lib/api-response';
import { petkitFeedSchema, validateBody } from '@/lib/validators';
import { canActOnHome } from '@/lib/permissions';
import { logger } from '@/lib/logger';

/**
 * POST /api/petkit/feed
 * Triggers a manual feed on the PetKit feeder, for the admin group only (`canActOnHome`).
 * Body: { deviceId: number, amount1?: number, amount2?: number }
 *
 * @returns 200 once dispensed, 400 on an invalid body, 403 outside the admin group, 500 when PetKit fails.
 */
export const POST = withAuth(async (request, { user, userEmail }) => {
    if (!canActOnHome(user)) {
        logger.security('Blocked feeder action', { userEmail });
        return ApiResponse.forbidden('Forbidden: Group restriction');
    }

    const validation = await validateBody(request, petkitFeedSchema);
    if (!validation.success) return validation.error;

    const { deviceId, amount1, amount2 } = validation.data;

    try {
        const success = await triggerFeederManual(deviceId, amount1, amount2);
        return success
            ? ApiResponse.success({ message: `Dispensé: Bac 1: ${amount1}, Bac 2: ${amount2}` })
            : ApiResponse.serverError('Failed to feed from PetKit');
    } catch (error) {
        logger.error('[PetKit Feed API] Error', { error: String(error) });
        return ApiResponse.serverError('Failed to process feed request');
    }
});
