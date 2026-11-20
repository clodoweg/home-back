/**
 * POST /api/push/unsubscribe — Forgets this browser's Web Push subscription (POST rather than
 * DELETE: the CORS policy only allows GET and POST).
 */
import { withAuth } from '@/lib/api-middleware';
import { ApiResponse } from '@/lib/api-response';
import prisma from '@/lib/prisma';
import { pushUnsubscribeSchema, validateBody } from '@/lib/validators';

export const POST = withAuth(async (request, { user }) => {
    const validation = await validateBody(request, pushUnsubscribeSchema);
    if (!validation.success) return validation.error;

    // Scoped to the caller: another user's endpoint is left alone.
    const { count } = await prisma.webPushSubscription.deleteMany({
        where: { userId: user.id, endpoint: validation.data.endpoint },
    });
    return ApiResponse.success({ deleted: count });
});
