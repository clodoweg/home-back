/** GET /api/notifications — The admin's latest alerts for the front's bell, with the unread count. */
import { withAuth } from '@/lib/api-middleware';
import { ApiResponse } from '@/lib/api-response';
import { canReceiveNotifications } from '@/lib/permissions';
import prisma from '@/lib/prisma';

/** How many notifications the bell lists. */
const LIST_LIMIT = 50;

export const GET = withAuth(async (_request, { user }) => {
    if (!canReceiveNotifications(user)) return ApiResponse.forbidden('Notifications are for admins');

    const [notifications, unread] = await Promise.all([
        prisma.notification.findMany({
            where: { userId: user.id },
            orderBy: { createdAt: 'desc' },
            take: LIST_LIMIT,
            select: { id: true, category: true, title: true, body: true, createdAt: true, readAt: true },
        }),
        prisma.notification.count({ where: { userId: user.id, readAt: null } }),
    ]);

    return ApiResponse.success({
        notifications: notifications.map(({ readAt, createdAt, ...rest }) => ({
            ...rest,
            createdAt: createdAt.toISOString(),
            read: readAt !== null,
        })),
        unread,
    });
});
