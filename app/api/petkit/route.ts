import { withAuth } from '@/lib/api-middleware';
import { ApiResponse } from '@/lib/api-response';
import { logger } from '@/lib/logger';
import { getFormattedPetkitData } from '@/lib/integrations/petkit';
import { canAccessHistory } from '@/lib/permissions';

/**
 * GET /api/petkit?days=N
 * 
 * Returns PetKit data from the database via the dedicated service.
 * Standardized pure API controller.
 */
export const GET = withAuth(async (request, { user }) => {
    try {
        const { searchParams } = new URL(request.url);
        const days = Math.max(1, Math.min(30, Number(searchParams.get('days') || '1')));

        const hasHistoryAccess = canAccessHistory(user);
        const data = await getFormattedPetkitData(days, hasHistoryAccess);

        const response = ApiResponse.success(data);
        // The body depends on the caller's group: no shared cache may ever store it
        response.headers.set('Cache-Control', 'private, no-store');
        return response;
    } catch (error) {
        logger.error('[PetKit] Request failed', { error: String(error) });
        return ApiResponse.serverError();
    }
});
