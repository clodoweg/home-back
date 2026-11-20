/**
 * Petkit media URL tests — the device id comes from PETKIT_DEVICE_ID (personal identifier,
 * never in the repository); without it, no snapshot URL is built.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getHAMediaProxyUrl } from '@/lib/integrations/petkit/feeder';

const SNAPSHOT_TIME = Date.UTC(2026, 2, 15, 11, 0, 0) / 1000;

describe('getHAMediaProxyUrl', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('builds the media path from PETKIT_DEVICE_ID and the Paris day', () => {
        vi.stubEnv('PETKIT_DEVICE_ID', '424242');
        const url = getHAMediaProxyUrl(SNAPSHOT_TIME, 3);
        expect(decodeURIComponent(url.split('media_content_id=')[1])).toBe(
            `media-source://local/media/424242/20260315/eat/snapshot/424242_${SNAPSHOT_TIME}.jpg`,
        );
    });

    it('returns no URL without PETKIT_DEVICE_ID', () => {
        vi.stubEnv('PETKIT_DEVICE_ID', ' ');
        expect(getHAMediaProxyUrl(SNAPSHOT_TIME, 3)).toBe('');
    });

    it('returns no URL for an unknown event type', () => {
        expect(getHAMediaProxyUrl(SNAPSHOT_TIME, 99)).toBe('');
    });
});
