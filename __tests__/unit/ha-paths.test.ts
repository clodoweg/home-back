import { describe, it, expect } from 'vitest';
import { buildHistoryPath, parseMediaContentId, resolveHaUrl } from '@/lib/ha-paths';

const START = '2026-01-01T00:00:00.000Z';
const END = '2026-01-02T00:00:00.000Z';
const ENCODED_START = encodeURIComponent(START);

const query = (value: string) => new URLSearchParams(value);

describe('buildHistoryPath', () => {
    it('builds the simplified format used by getHistory', () => {
        const path = buildHistoryPath([], query(`entity_id=sensor.temp&start_time=${START}&end_time=${END}`));
        expect(path).toBe(`/api/history/period/${ENCODED_START}?filter_entity_id=sensor.temp&end_time=${encodeURIComponent(END)}`);
    });

    it('builds the period format used by useHABatchHistory', () => {
        const path = buildHistoryPath(['period', START], query(`filter_entity_id=sensor.a,sensor.b&end_time=${END}`));
        expect(path).toBe(
            `/api/history/period/${ENCODED_START}?filter_entity_id=sensor.a%2Csensor.b&end_time=${encodeURIComponent(END)}`,
        );
    });

    it('keeps HA flags but drops their values', () => {
        const path = buildHistoryPath(['period'], query('filter_entity_id=sensor.a&minimal_response=evil&no_attributes'));
        expect(path).toBe('/api/history/period?filter_entity_id=sensor.a&minimal_response=&no_attributes=');
    });

    it('never forwards unknown query keys', () => {
        const path = buildHistoryPath(['period', START], query('filter_entity_id=sensor.a&api_password=x&../config=1'));
        expect(path).toBe(`/api/history/period/${ENCODED_START}?filter_entity_id=sensor.a`);
    });

    it.each([
        [['..', 'config'], 'filter_entity_id=sensor.a'],
        [['../config'], 'filter_entity_id=sensor.a'],
        [['period', '../../config'], 'filter_entity_id=sensor.a'],
        [['period', `${START}/../../error_log`], 'filter_entity_id=sensor.a'],
        [['period', START, 'extra'], 'filter_entity_id=sensor.a'],
        [['states'], 'filter_entity_id=sensor.a'],
        [['period', START], 'filter_entity_id=sensor.a/../../config'],
        [['period', START], 'filter_entity_id=SENSOR.A'],
        [['period', START], ''],
        [['period', START], 'filter_entity_id=sensor.a&end_time=tomorrow'],
    ])('rejects slug %j with query "%s" (path traversal / malformed input)', (slug, rawQuery) => {
        expect(buildHistoryPath(slug, query(rawQuery))).toBeNull();
    });

    it('rejects an incomplete simplified format instead of forwarding the raw query', () => {
        expect(buildHistoryPath([], query('entity_id=sensor.temp'))).toBeNull();
        expect(buildHistoryPath([], query(`entity_id=../config&start_time=${START}&end_time=${END}`))).toBeNull();
    });

    it('caps the number of entities per call', () => {
        const ids = Array.from({ length: 101 }, (_, i) => `sensor.s${i}`).join(',');
        expect(buildHistoryPath(['period'], query(`filter_entity_id=${ids}`))).toBeNull();
    });
});

describe('parseMediaContentId', () => {
    it('accepts the IDs built by the Petkit service', () => {
        const id = 'media-source://local/media/100000001/20260101/feed/snapshot/100000001_081500.jpg';
        expect(parseMediaContentId(id)).toEqual({
            provider: 'local',
            relativePath: 'media/100000001/20260101/feed/snapshot/100000001_081500.jpg',
        });
        expect(parseMediaContentId('media-source://petkit/a/b-c_d.png')).toEqual({ provider: 'petkit', relativePath: 'a/b-c_d.png' });
    });

    it.each([
        'media-source://local/../../error_log',
        'media-source://local/media/../../config.jpg',
        'media-source://local/media/%2e%2e/config.jpg',
        'media-source://local/media/a.jpg?x=1',
        'media-source://local/media/a.txt',
        'media-source://media_source/local/a.jpg',
        'media-source://tts/a.jpg',
        'https://evil.example/a.jpg',
        '../../error_log',
    ])('rejects %s', (id) => {
        expect(parseMediaContentId(id)).toBeNull();
    });
});

describe('resolveHaUrl', () => {
    const HA = 'http://ha.local:8123';

    it('resolves relative paths on the HA origin', () => {
        expect(resolveHaUrl('/api/media/x.jpg', HA)).toBe('http://ha.local:8123/api/media/x.jpg');
        expect(resolveHaUrl('media/x.jpg', HA)).toBe('http://ha.local:8123/media/x.jpg');
    });

    it('accepts absolute URLs on the HA origin', () => {
        expect(resolveHaUrl('http://ha.local:8123/media/x.jpg', HA)).toBe('http://ha.local:8123/media/x.jpg');
    });

    it.each(['https://evil.example/x.jpg', '//evil.example/x.jpg', 'http://ha.local:9999/x.jpg', 'https://ha.local:8123/x.jpg'])(
        'refuses off-origin URL %s (the HA token must not leak)',
        (url) => {
            expect(resolveHaUrl(url, HA)).toBeNull();
        },
    );
});
