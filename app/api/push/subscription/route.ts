/** POST /api/push/subscription — Registers this browser's Web Push subscription for the admin's alerts. */
import { withAuth } from '@/lib/api-middleware';
import { ApiResponse } from '@/lib/api-response';
import { canReceiveNotifications } from '@/lib/permissions';
import prisma from '@/lib/prisma';
import { pushSubscriptionSchema, validateBody } from '@/lib/validators';

export const POST = withAuth(async (request, { user }) => {
    if (!canReceiveNotifications(user)) return ApiResponse.forbidden('Notifications are for admins');

    const validation = await validateBody(request, pushSubscriptionSchema);
    if (!validation.success) return validation.error;
    const { endpoint, keys } = validation.data;

    // An endpoint identifies one browser: re-subscribing it (new keys, other account) replaces it.
    await prisma.webPushSubscription.upsert({
        where: { endpoint },
        create: { userId: user.id, endpoint, p256dh: keys.p256dh, auth: keys.auth },
        update: { userId: user.id, p256dh: keys.p256dh, auth: keys.auth },
    });
    return ApiResponse.success({ subscribed: true }, 201);
});
