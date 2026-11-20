/** GET /api/push/public-key — VAPID public key the browser subscribes with (null when push is off). */
import { withAuth } from '@/lib/api-middleware';
import { ApiResponse } from '@/lib/api-response';
import { vapidPublicKey } from '@/lib/integrations/notifications';
import { canReceiveNotifications } from '@/lib/permissions';

export const GET = withAuth(async (_request, { user }) => {
    if (!canReceiveNotifications(user)) return ApiResponse.forbidden('Notifications are for admins');
    return ApiResponse.success({ publicKey: vapidPublicKey() });
});
