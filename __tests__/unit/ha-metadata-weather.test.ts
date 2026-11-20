/** Unit tests — metadata template output parsing and forecast extraction */
import { describe, it, expect } from 'vitest';
import { ENTITY_METADATA_TEMPLATE, parseEntityMetadata } from '@/lib/integrations/ha-metadata';
import { extractForecast } from '@/lib/integrations/weather';

describe('ENTITY_METADATA_TEMPLATE', () => {
    it('covers light, sensor and climate and serializes every value with tojson', () => {
        for (const domain of ['light', 'sensor', 'climate']) {
            expect(ENTITY_METADATA_TEMPLATE).toContain(`{% for state in states.${domain} %}`);
        }
        expect(ENTITY_METADATA_TEMPLATE).toContain('(state.entity_id | tojson)');
        expect(ENTITY_METADATA_TEMPLATE).toContain('} | tojson)');
        // No hand-built JSON string around a HA value
        expect(ENTITY_METADATA_TEMPLATE).not.toContain(`'"' +`);
    });
});

describe('parseEntityMetadata', () => {
    it('parses the rendered JSON text, quotes in names included', () => {
        expect(parseEntityMetadata('{"light.a": {"area": "Salle \\"bleue\\"", "floor": "1er", "model": "Hue"}}')).toEqual({
            'light.a': { area: 'Salle "bleue"', floor: '1er', model: 'Hue' },
        });
    });

    it('accepts an already parsed object and normalizes missing or non-string fields', () => {
        expect(parseEntityMetadata({ 'sensor.a': { area: null, model: 42 }, 'sensor.b': 'oops' })).toEqual({
            'sensor.a': { area: '', floor: '', model: '42' },
        });
    });

    it('parses an empty template result', () => {
        expect(parseEntityMetadata('{  }')).toEqual({});
    });

    it.each(['{ broken', '[]', 'null', 42, null])('returns null for %s', (raw) => {
        expect(parseEntityMetadata(raw)).toBeNull();
    });
});

describe('extractForecast', () => {
    const forecast = [{ datetime: '2026-10-26T11:00:00+00:00', temperature: 18 }];

    it('reads service_response first, then the bare form', () => {
        expect(extractForecast({ service_response: { 'weather.a': { forecast } } }, 'weather.a')).toEqual(forecast);
        expect(extractForecast({ 'weather.a': { forecast } }, 'weather.a')).toEqual(forecast);
    });

    it.each([
        [null],
        ['text'],
        [{}],
        [{ service_response: { 'weather.b': { forecast } } }],
        [{ 'weather.a': { forecast: 'not-a-list' } }],
        [{ 'weather.a': {} }],
    ])('returns [] for %j', (response) => {
        expect(extractForecast(response, 'weather.a')).toEqual([]);
    });
});
