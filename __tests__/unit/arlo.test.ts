import { describe, it, expect, beforeEach } from 'vitest';
import { triggerArloSnapshot } from '@/lib/integrations/arlo';
import { mockHaPost, resetHAMocks } from '../helpers/mock-ha';

const ok = { ok: true, status: 200, duration: 1, data: {} };
const ko = { ok: false, status: 500, duration: 1, data: null };

describe('Arlo snapshots', () => {
    beforeEach(() => {
        resetHAMocks();
    });

    it('requests a capture through the aarlo service and the snapshot switch', async () => {
        mockHaPost.mockResolvedValue(ok);

        expect(await triggerArloSnapshot('camera.aarlo_salon', 'snapshot')).toBe(true);

        expect(mockHaPost).toHaveBeenCalledWith('/api/services/aarlo/camera_request_snapshot', { entity_id: 'camera.aarlo_salon' }, 'snapshot:aarlo:salon');
        expect(mockHaPost).toHaveBeenCalledWith('/api/services/switch/turn_on', { entity_id: 'switch.aarlo_snapshot_salon' }, 'snapshot:switch:salon');
    });

    it('succeeds when one trigger works and fails when both are refused', async () => {
        mockHaPost.mockResolvedValueOnce(ko).mockResolvedValueOnce(ok);
        expect(await triggerArloSnapshot('camera.aarlo_salon', 'snapshot')).toBe(true);

        mockHaPost.mockResolvedValue(ko);
        expect(await triggerArloSnapshot('camera.aarlo_salon', 'snapshot')).toBe(false);
    });
});
