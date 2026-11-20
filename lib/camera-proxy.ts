/**
 * Camera Proxy Service
 * Handles secure camera snapshots proxied from Home Assistant.
 */
import { ApiResponse } from './api-response';
import { canProxyCamera } from './permissions';
import type { AuthUser } from './user';
import { logger } from './logger';
import { proxyImageViaR2 } from './r2';
import { hasHAConfig } from './env';
import { haFetchBinary } from './haClient';
import { cameraEntityIdPattern } from './validators';

interface ProxyOptions {
    entity_id: string;
    user: AuthUser;
}

/**
 * Proxies the current snapshot of a camera from Home Assistant.
 * Centralizes permissions and HA connectivity logic.
 *
 * @param options - Camera entity and authenticated user.
 * @returns The image (or an R2 redirect); 400, 403, 404 (unknown camera), 502 (other HA error)
 * or 500 otherwise.
 */
export async function proxyCamera(options: ProxyOptions) {
    const { entity_id, user } = options;

    // 1. Validation
    if (!cameraEntityIdPattern.test(entity_id)) {
        return ApiResponse.badRequest("Invalid entity_id: must be a camera");
    }

    // 2. Permission Check
    if (!canProxyCamera(user, entity_id)) {
        logger.security('Blocked camera image', { userEmail: user.email, entityId: entity_id });
        return ApiResponse.forbidden('Forbidden: You do not have permission for this camera');
    }

    // 4. HA Configuration
    if (!hasHAConfig()) {
        logger.error("[CameraProxy] Missing HA environment variables");
        return ApiResponse.serverError("Server Configuration Error");
    }

    try {
        const image = await haFetchBinary(`/api/camera_proxy/${encodeURIComponent(entity_id)}`, { label: 'camera' });
        if (!image.ok || !image.bytes) {
            // 404 keeps its meaning (unknown camera); any other HA status, 401/403 from an
            // invalid HA token above all, must not look like an expired Clerk session to the front
            return image.status === 404
                ? ApiResponse.notFound('Camera not found')
                : ApiResponse.error('Failed to fetch camera image from Home Assistant', 502);
        }

        // A public R2 bucket serves the image instead of the function. The key carries a random
        // part: a public URL must not be guessable from the camera name and the time.
        const key = `cameras/${entity_id}/${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}.jpg`;
        return await proxyImageViaR2(Buffer.from(image.bytes), key, image.contentType || 'image/jpeg', 'private, no-store');
    } catch (error) {
        logger.error('[CameraProxy] Error during image proxy', { error: String(error) });
        return ApiResponse.serverError('Internal error during image proxying');
    }
}
