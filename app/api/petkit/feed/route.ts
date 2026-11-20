import { withAuth } from '@/lib/api-middleware';
import { triggerFeederManual } from '@/lib/integrations/petkit';
import { ApiResponse } from '@/lib/api-response';
import { petkitFeedSchema, validateBody } from '@/lib/validators';
import { logger } from '@/lib/logger';

/**
 * POST /api/petkit/feed
 * Triggers a manual feed on the PetKit feeder.
 * Body: { deviceId: number, amount1?: number, amount2?: number }
 */
export const POST = withAuth(async (request: Request) => {
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
