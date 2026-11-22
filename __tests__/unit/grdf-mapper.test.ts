
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockHaGet, resetHAMocks } from '../helpers/mock-ha';
import { getGrdfData, mapGrdfAttributes } from '@/lib/integrations/grdf/service';

describe('GRDF Mapper (Gazpar)', () => {
    const startDate = new Date(Date.UTC(2025, 1, 1)); // 2025-02-01
    const endDate = new Date(Date.UTC(2025, 1, 15));  // 2025-02-15

    it('should parse single daily entries correctly', () => {
        const attributes = {
            daily: [
                { time_period: '01/02/2025', energy_kwh: '50.5', temperature_degC: '5.2' },
                { time_period: '02/02/2025', energy_kwh: '45.0', temperature_degC: '6.0' }
            ]
        };

        const result = mapGrdfAttributes(attributes, startDate, endDate);

        expect(result).toHaveLength(2);
        expect(result[0]).toMatchObject({
            date: new Date(Date.UTC(2025, 1, 1)),
            value: 50.5,
            temp: 5.2,
            isEstimate: false
        });
    });

    it('should split weekly/range entries into daily estimates', () => {
        // Range of 3 days (03, 04, 05)
        const attributes = {
            daily: [
                { time_period: 'Du 03/02/2025 au 05/02/2025', energy_kwh: '30.0' }
            ]
        };

        const result = mapGrdfAttributes(attributes, startDate, endDate);

        expect(result).toHaveLength(3);
        expect(result[0].value).toBe(10.0); // 30 / 3
        expect(result[0].isEstimate).toBe(true);
        expect(result[0].date).toEqual(new Date(Date.UTC(2025, 1, 3)));
        expect(result[2].date).toEqual(new Date(Date.UTC(2025, 1, 5)));
    });

    it('should split monthly entries into daily estimates', () => {
        // February 2025 has 28 days
        const attributes = {
            monthly: [
                { time_period: 'Février 2025', energy_kwh: '280.0' }
            ]
        };

        // Filter for only first 15 days
        const result = mapGrdfAttributes(attributes, startDate, endDate);

        expect(result).toHaveLength(15);
        expect(result[0].value).toBe(10.0); // 280 / 28
        expect(result[0].isEstimate).toBe(true);
        expect(result[0].date.getUTCDate()).toBe(1);
        expect(result[14].date.getUTCDate()).toBe(15);
    });

    it('should respect date filtering (startDate/endDate)', () => {
        const attributes = {
            daily: [
                { time_period: '31/01/2025', energy_kwh: '10' }, // Before
                { time_period: '01/02/2025', energy_kwh: '20' }, // In
                { time_period: '16/02/2025', energy_kwh: '30' }  // After
            ]
        };

        const result = mapGrdfAttributes(attributes, startDate, endDate);

        expect(result).toHaveLength(1);
        expect(result[0].value).toBe(20);
    });

    it('should prioritize daily over monthly data (deduplication)', () => {
        const attributes = {
            daily: [
                { time_period: '01/02/2025', energy_kwh: '100' } // Precise
            ],
            monthly: [
                { time_period: 'Février 2025', energy_kwh: '280' } // Backfill (10 per day)
            ]
        };

        const result = mapGrdfAttributes(attributes, startDate, endDate);

        // Result should have 15 days (01 to 15)
        // Day 01 should be 100 (daily), others should be 10 (monthly)
        expect(result).toHaveLength(15);
        const day1 = result.find(d => d.date.getUTCDate() === 1);
        const day2 = result.find(d => d.date.getUTCDate() === 2);

        expect(day1?.value).toBe(100);
        expect(day1?.isEstimate).toBe(false);
        expect(day2?.value).toBe(10);
        expect(day2?.isEstimate).toBe(true);
    });

    it('should return empty array if attributes are missing or malformed', () => {
        expect(mapGrdfAttributes({}, startDate, endDate)).toEqual([]);
        expect(mapGrdfAttributes({ daily: [{}] }, startDate, endDate)).toEqual([]);
    });
});

describe('getGrdfData — default range (F09)', () => {
    beforeEach(() => {
        resetHAMocks();
        vi.useFakeTimers({ now: new Date(Date.UTC(2026, 9, 22, 12)) });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('covers the 30 days before an end date in another month', async () => {
        // Each French daily entry from 1 to 5 March, and from 1 to 28 February
        const daily = [
            ...Array.from({ length: 28 }, (_, i) => ({ time_period: `${String(i + 1).padStart(2, '0')}/02/2026`, energy_kwh: '1' })),
            ...Array.from({ length: 5 }, (_, i) => ({ time_period: `${String(i + 1).padStart(2, '0')}/03/2026`, energy_kwh: '1' })),
        ];
        mockHaGet.mockResolvedValue({ ok: true, status: 200, duration: 1, data: { attributes: { daily } } });

        const records = await getGrdfData(undefined, new Date(Date.UTC(2026, 2, 5, 12)));

        const days = records.map(r => r.date.toISOString().slice(0, 10)).sort((a, b) => a.localeCompare(b));
        expect(days[0]).toBe('2026-02-04');
        expect(days[days.length - 1]).toBe('2026-03-05');
    });
});
