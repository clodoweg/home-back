import { withAuth } from '@/lib/api-middleware';
import { proxyCamera } from '@/lib/camera-proxy';

export const GET = withAuth<{ entity_id: string }>(async (_request, { params, user }) => {
    const { entity_id } = await params;

    return await proxyCamera({
        entity_id,
        user,
    });
});
