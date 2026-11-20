/** POST /api/notifications/read — Marks the given notifications (or all unread ones) as read. */
import { withAuth } from '@/lib/api-middleware';
import { ApiResponse } from '@/lib/api-response';
import { canReceiveNotifications } from '@/lib/permissions';
import prisma from '@/lib/prisma';
import { markNotificationsReadSchema, validateBody } from '@/lib/validators';

export const POST = withAuth(async (request, { user }) => {
    if (!canReceiveNotifications(user)) return ApiResponse.forbidden('Notifications are for admins');

    const validation = await validateBody(request, markNotificationsReadSchema);
    if (!validation.success) return validation.error;
    const { ids } = validation.data;

    // Scoped to the caller: ids of another user's notifications match nothing.
    const { count } = await prisma.notification.updateMany({
        where: { userId: user.id, readAt: null, ...(ids ? { id: { in: ids } } : {}) },
        data: { readAt: new Date() },
    });
    return ApiResponse.success({ updated: count });
});
