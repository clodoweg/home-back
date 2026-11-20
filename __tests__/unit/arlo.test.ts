import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { captureCameraPhotos, triggerArloSnapshot } from '@/lib/integrations/arlo';
import { mockHaPost, resetHAMocks } from '../helpers/mock-ha';

const ok = { ok: true, status: 200, duration: 1, data: {} };
const ko = { ok: false, status: 500, duration: 1, data: null };

describe('Arlo snapshots', () => {
    beforeEach(() => {
        resetHAMocks();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
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

    it('captures every camera after the capture delay and skips the failing ones', async () => {
        mockHaPost.mockImplementation(async (path: string) => {
            if (path.includes('aarlo/')) throw new Error('aarlo down');
            return ok;
        });
        const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
            const id = String(url);
            if (id.endsWith('camera.aarlo_salon')) return new Response(new Uint8Array([1, 2, 3]));
            if (id.endsWith('camera.aarlo_entree')) return new Response(new Uint8Array([]));
            if (id.endsWith('camera.aarlo_jardin')) throw new Error('offline');
            return new Response(null, { status: 404 });
        });

        const pending = captureCameraPhotos(['camera.aarlo_salon', 'camera.aarlo_entree', 'camera.aarlo_jardin', 'camera.aarlo_cave']);
        await vi.advanceTimersByTimeAsync(3999);
        expect(fetchSpy).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        const photos = await pending;

        expect(photos).toEqual([{ buffer: expect.any(ArrayBuffer), filename: 'camera.aarlo_salon.jpg' }]);
        expect(fetchSpy.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer test-ha-token' } });
    });
});
