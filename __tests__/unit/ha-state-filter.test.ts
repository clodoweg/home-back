/** Tests of lib/ha-state-filter.ts: no GPS position nor camera access ever reaches the front (audit M1) */
import { describe, it, expect } from 'vitest';
import { sanitizeHAHistory, sanitizeHAState, sanitizeHAStates } from '@/lib/ha-state-filter';

const PHONE = {
    entity_id: 'device_tracker.phone',
    state: 'home',
    attributes: { friendly_name: 'Phone', latitude: 48.85, longitude: 2.35, gps_accuracy: 12, altitude: 35, battery_level: 80, source_type: 'gps' },
};

const CAMERA = {
    entity_id: 'camera.aarlo_jardin',
    state: 'idle',
    attributes: {
        friendly_name: 'Jardin',
        access_token: 'secret-camera-token',
        entity_picture: '/api/camera_proxy/camera.aarlo_jardin?token=secret-camera-token',
        last_thumbnail: 'https://arlo.example/recordings/1791392584171_thumb.jpg?Expires=1&Signature=abc#frag',
        last_video: 'https://arlo.example/recordings/1791392584171.mp4?Signature=abc',
        image_source: 'snapshot/10-07 19:46',
    },
};

describe('sanitizeHAState', () => {
    it('removes the GPS position and keeps everything else', () => {
        expect(sanitizeHAState(PHONE).attributes).toEqual({ friendly_name: 'Phone', battery_level: 80, source_type: 'gps' });
    });

    it('removes the camera access and keeps the unsigned thumbnail path the widget reads', () => {
        expect(sanitizeHAState(CAMERA).attributes).toEqual({
            friendly_name: 'Jardin',
            last_thumbnail: 'https://arlo.example/recordings/1791392584171_thumb.jpg',
            image_source: 'snapshot/10-07 19:46',
        });
    });

    it('keeps a thumbnail that is not a string as is', () => {
        const state = { entity_id: 'camera.x', state: 'idle', attributes: { last_thumbnail: null } };

        expect(sanitizeHAState(state).attributes).toEqual({ last_thumbnail: null });
    });

    it('never mutates the cached state', () => {
        const copy = structuredClone(CAMERA);

        sanitizeHAState(CAMERA);

        expect(CAMERA).toEqual(copy);
    });

    it('returns a state without attributes unchanged (minimal history entries)', () => {
        const minimal = { state: '21.5', last_changed: '2026-01-01T00:00:00Z' };

        expect(sanitizeHAState(minimal)).toBe(minimal);
    });
});

describe('sanitizeHAStates', () => {
    it('filters every state of the list', () => {
        const [phone, camera] = sanitizeHAStates([PHONE, CAMERA]);

        expect(phone.attributes).not.toHaveProperty('latitude');
        expect(camera.attributes).not.toHaveProperty('access_token');
    });
});

describe('sanitizeHAHistory', () => {
    it('filters each series of a history answer (a tracker history is a GPS trail)', () => {
        const history = sanitizeHAHistory([[PHONE, { state: 'away', last_changed: '2026-01-01T01:00:00Z' }], [CAMERA]]) as typeof PHONE[][];

        expect(history[0][0].attributes).not.toHaveProperty('longitude');
        expect(history[0][1]).toEqual({ state: 'away', last_changed: '2026-01-01T01:00:00Z' });
        expect(history[1][0].attributes).not.toHaveProperty('entity_picture');
    });

    it('returns anything else unchanged', () => {
        expect(sanitizeHAHistory(null)).toBeNull();
        expect(sanitizeHAHistory({ error: 'x' })).toEqual({ error: 'x' });
        expect(sanitizeHAHistory(['not a series'])).toEqual(['not a series']);
    });
});
