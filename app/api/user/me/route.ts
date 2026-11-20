import { withAuth } from '@/lib/api-middleware';
import { ApiResponse } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (_request, { user }) => {
    const response = ApiResponse.success({
        email: user.email,
        group: user.group || 'user',
        permissions: user.userGroup?.permissions || [],
        widgetPreferences: user.widgetPreferences,
        theme: user.theme || 'dark',
    });
    // The body is the caller's own profile: no shared cache may ever store it
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
});
