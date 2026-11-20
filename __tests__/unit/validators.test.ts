/**
 * Unit tests for lib/validators.ts — Zod schemas
 */
import { describe, it, expect } from 'vitest';
import {
    entityIdSchema,
    domainSchema,
    serviceSchema,
    callSchema,
    templateSchema,
    validateBody,
    validateQuery,
    forecastQuerySchema,
} from '@/lib/validators';

describe('entityIdSchema', () => {
    it('accepts valid entity ID', () => {
        expect(entityIdSchema.safeParse('light.salon').success).toBe(true);
        expect(entityIdSchema.safeParse('sensor.temperature_bureau').success).toBe(true);
    });

    it('accepts array of entity IDs', () => {
        expect(entityIdSchema.safeParse(['light.salon', 'light.chambre']).success).toBe(true);
    });

    it('rejects invalid format', () => {
        expect(entityIdSchema.safeParse('invalid').success).toBe(false);
        expect(entityIdSchema.safeParse('LIGHT.salon').success).toBe(false);
        expect(entityIdSchema.safeParse('').success).toBe(false);
    });

    it('rejects injection attempts', () => {
        expect(entityIdSchema.safeParse('light.salon"; DROP TABLE--').success).toBe(false);
        expect(entityIdSchema.safeParse('light.<script>').success).toBe(false);
    });
});

describe('domainSchema', () => {
    it('accepts valid domains', () => {
        expect(domainSchema.safeParse('light').success).toBe(true);
        expect(domainSchema.safeParse('climate').success).toBe(true);
        expect(domainSchema.safeParse('alarm_control_panel').success).toBe(true);
    });

    it('rejects invalid domains', () => {
        expect(domainSchema.safeParse('').success).toBe(false);
        expect(domainSchema.safeParse('Light').success).toBe(false);
        expect(domainSchema.safeParse('a').success).toBe(false); // min 2
    });
});

describe('serviceSchema', () => {
    it('accepts valid services', () => {
        expect(serviceSchema.safeParse('turn_on').success).toBe(true);
        expect(serviceSchema.safeParse('toggle').success).toBe(true);
    });

    it('rejects invalid services', () => {
        expect(serviceSchema.safeParse('Turn_On').success).toBe(false);
        expect(serviceSchema.safeParse('a').success).toBe(false);
    });
});

describe('callSchema', () => {
    it('accepts valid call payload', () => {
        const result = callSchema.safeParse({
            domain: 'climate',
            service: 'set_temperature',
            entity_id: 'climate.bureau',
            service_data: { temperature: 22 },
        });
        expect(result.success).toBe(true);
    });

    it('accepts call with return_response', () => {
        const result = callSchema.safeParse({
            domain: 'weather',
            service: 'get_forecasts',
            entity_id: 'weather.home',
            return_response: true,
        });
        expect(result.success).toBe(true);
    });
});

describe('templateSchema', () => {
    it('accepts valid template', () => {
        const result = templateSchema.safeParse({
            template: '{{ states("light.salon") }}',
        });
        expect(result.success).toBe(true);
    });

    it('rejects empty template', () => {
        expect(templateSchema.safeParse({ template: '' }).success).toBe(false);
    });

    it('rejects missing template', () => {
        expect(templateSchema.safeParse({}).success).toBe(false);
    });
});

describe('validateBody', () => {
    it('returns success for valid JSON body', async () => {
        const request = new Request('http://test.local', {
            method: 'POST',
            body: JSON.stringify({ domain: 'light', service: 'toggle', entity_id: 'light.salon' }),
            headers: { 'Content-Type': 'application/json' },
        });

        const result = await validateBody(request, callSchema);
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.domain).toBe('light');
        }
    });

    it('returns error for invalid body', async () => {
        const request = new Request('http://test.local', {
            method: 'POST',
            body: JSON.stringify({ domain: 'INVALID' }),
            headers: { 'Content-Type': 'application/json' },
        });

        const result = await validateBody(request, callSchema);
        expect(result.success).toBe(false);
    });

    it('returns error for non-JSON body', async () => {
        const request = new Request('http://test.local', {
            method: 'POST',
            body: 'not json',
        });

        const result = await validateBody(request, callSchema);
        expect(result.success).toBe(false);
    });
});

describe('forecastQuerySchema / validateQuery', () => {
    const parse = (query: string) => validateQuery(new URLSearchParams(query), forecastQuerySchema);

    it('accepts a weather entity with a daily or hourly type', () => {
        expect(parse('entity_id=weather.maison&type=daily')).toEqual({ success: true, data: { entity_id: 'weather.maison', type: 'daily' } });
        expect(parse('entity_id=weather.maison&type=hourly').success).toBe(true);
    });

    it.each([
        'type=daily',
        'entity_id=weather.maison',
        'entity_id=weather.maison&type=twice_daily',
        'entity_id=light.salon&type=daily',
        'entity_id=weather.x/../config&type=daily',
        `entity_id=weather.${'a'.repeat(100)}&type=daily`,
    ])('rejects %s with a 400 listing the fields', async (query) => {
        const result = parse(query);
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.status).toBe(400);
            expect((await result.error.json()).details.length).toBeGreaterThan(0);
        }
    });
});
