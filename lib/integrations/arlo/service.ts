/**
 * Arlo service — captures via l'intégration aarlo de Home Assistant.
 * A capture is requested both through the native aarlo service and the snapshot switch,
 * since setups differ on which one actually triggers the camera.
 */
import { haPost } from '@/lib/haClient';

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
