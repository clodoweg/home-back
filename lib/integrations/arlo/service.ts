/**
 * Arlo service — captures via l'intégration aarlo de Home Assistant.
 * A capture is requested both through the native aarlo service and the snapshot switch,
 * since setups differ on which one actually triggers the camera.
 */
import { haFetchBinary, haPost } from '@/lib/haClient';
import { logger } from '@/lib/logger';
import type { CameraPhoto } from './types';

/** Arlo needs a moment to capture and refresh the HA camera proxy image. */
const CAPTURE_DELAY_MS = 4000;

/**
 * Requests a fresh snapshot from an Arlo camera.
 *
 * @param entityId Camera entity, `camera.aarlo_<name>`.
 * @param label Trace label for the HA calls.
 * @returns true when at least one of the two triggers was accepted by HA.
 */
export async function triggerArloSnapshot(entityId: string, label: string): Promise<boolean> {
    const suffix = entityId.replace('camera.aarlo_', '');
    const [aarloRes, switchRes] = await Promise.all([
        haPost('/api/services/aarlo/camera_request_snapshot', { entity_id: entityId }, `${label}:aarlo:${suffix}`),
        haPost('/api/services/switch/turn_on', { entity_id: `switch.aarlo_snapshot_${suffix}` }, `${label}:switch:${suffix}`),
    ]);
    return aarloRes.ok || switchRes.ok;
}

/**
 * Reads the current image of a camera through the HA camera proxy.
 *
 * @param entityId Camera entity id (already validated).
 * @returns The JPEG bytes, or null when HA has no image.
 */
async function fetchCameraImage(entityId: string): Promise<CameraPhoto | null> {
    try {
        const image = await haFetchBinary(`/api/camera_proxy/${encodeURIComponent(entityId)}`, { label: 'alert-photo' });
        if (!image.ok || !image.bytes || image.bytes.byteLength === 0) return null;
        return { buffer: image.bytes.buffer, filename: `${entityId}.jpg` };
    } catch (e) {
        logger.warn('[Arlo] camera proxy fetch failed', { entityId, error: String(e) });
        return null;
    }
}

/**
 * Triggers snapshots on several cameras, waits for the capture, then fetches the images.
 * Cameras that fail are skipped: an empty array means "fall back to a text-only message".
 *
 * @param cameraEntityIds Arlo camera entities.
 * @returns The captured photos.
 */
export async function captureCameraPhotos(cameraEntityIds: string[]): Promise<CameraPhoto[]> {
    await Promise.all(
        cameraEntityIds.map(entityId =>
            triggerArloSnapshot(entityId, 'alert-snapshot').catch(e => {
                logger.warn('[Arlo] snapshot trigger failed', { entityId, error: String(e) });
                return false;
            }),
        ),
    );

    await new Promise(resolve => setTimeout(resolve, CAPTURE_DELAY_MS));

    const photos = await Promise.all(cameraEntityIds.map(fetchCameraImage));
    return photos.filter((p): p is CameraPhoto => p !== null);
}
