/** HA image proxy — image d'une entité `image.*` de Home Assistant */
import { withAuth } from '@/lib/api-middleware';
import { ApiResponse } from '@/lib/api-response';
import { hasHAConfig } from '@/lib/env';
import { haFetchBinary } from '@/lib/haClient';
import { logger } from '@/lib/logger';
import { imageEntityIdPattern } from '@/lib/validators';

/**
 * GET /api/ha/image/[entity_id] — proxies `/api/image_proxy/<entity_id>` from HA.
 *
 * @returns 200 with the image, 400 if `entity_id` is not an `image.*` entity, 404 if HA has no
 * such image, 502 for any other HA error.
 */
export const GET = withAuth<{ entity_id: string }>(async (_request, { params }) => {
    const { entity_id } = await params;

    if (!imageEntityIdPattern.test(entity_id)) {
        logger.security('Rejected image entity_id', { entity_id: entity_id.slice(0, 100) });
        return ApiResponse.badRequest('Invalid entity_id: must be an image entity');
    }

    if (!hasHAConfig()) return ApiResponse.serverError('HA configuration missing');

    try {
        const image = await haFetchBinary(`/api/image_proxy/${encodeURIComponent(entity_id)}`, { label: 'image' });
        if (!image.ok || !image.bytes) {
            // 404 keeps its meaning (no such image entity); any other HA status, 401/403 from an
            // invalid HA token above all, must not look like an expired Clerk session to the front
            return image.status === 404
                ? ApiResponse.notFound('Image not found')
                : ApiResponse.error('Failed to fetch image from Home Assistant', 502);
        }

        // Authenticated content: browser cache only, never a shared cache
        return ApiResponse.image(image.bytes, image.contentType, 'private, max-age=3600');
    } catch (error) {
        logger.error('[HAImageProxy] Error', { entity_id, error: String(error) });
        return ApiResponse.serverError('Internal error during image proxying');
    }
});
