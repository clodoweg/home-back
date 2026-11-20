/**
 * Suez Water Attributes Mapper Unit Tests
 * Verifies daily parsing, monthly history splitting, and boundary constraints.
 */

import { describe, it, expect } from 'vitest';
import { mapSuezAttributes } from '@/lib/integrations/suez/service';

describe('Suez Mapper (mapSuezAttributes)', () => {
    const startDate = new Date('2026-05-01T00:00:00Z');
    const endDate = new Date('2026-05-15T23:59:59Z');

    it('should parse precise daily entries correctly', () => {
        const mockAttributes = {
            this_month_consumption: {
                '2026-05-01': 150,
                '2026-05-02': 160
            },
            previous_month_consumption: {
                '2026-04-30': 140
            }
        };

        const result = mapSuezAttributes(mockAttributes, startDate, endDate);

        // Within May 1 to May 15
        expect(result).toHaveLength(2);
        
        expect(result[0].date.toISOString()).toBe('2026-05-01T00:00:00.000Z');
        expect(result[0].value).toBe(150);
        expect(result[0].isEstimate).toBe(false);

        expect(result[1].date.toISOString()).toBe('2026-05-02T00:00:00.000Z');
        expect(result[1].value).toBe(160);
        expect(result[1].isEstimate).toBe(false);
    });

    it('should split monthly history entries into daily estimates', () => {
        // May 2026 has 31 days. 3100 L total -> 100 L per day.
        const mockAttributes = {
            history: {
                '2026-05': 3100
            }
        };

        const result = mapSuezAttributes(mockAttributes, startDate, endDate);

        // Filtered within range May 1 to May 15 -> 15 days
        expect(result).toHaveLength(15);
        expect(result[0].date.toISOString()).toBe('2026-05-01T00:00:00.000Z');
        expect(result[0].value).toBe(100);
        expect(result[0].isEstimate).toBe(true);

        expect(result[14].date.toISOString()).toBe('2026-05-15T00:00:00.000Z');
        expect(result[14].value).toBe(100);
        expect(result[14].isEstimate).toBe(true);
    });

    it('should prioritize daily precise data over monthly backfill estimates', () => {
        const mockAttributes = {
            this_month_consumption: {
                '2026-05-01': 250 // precise
            },
            history: {
                '2026-05': 3100 // estimates: 100 per day
            }
        };

        const result = mapSuezAttributes(mockAttributes, startDate, endDate);

        expect(result).toHaveLength(15); // May 1 to May 15
        const day1 = result.find(r => r.date.toISOString() === '2026-05-01T00:00:00.000Z');
        const day2 = result.find(r => r.date.toISOString() === '2026-05-02T00:00:00.000Z');

        expect(day1?.value).toBe(250);
        expect(day1?.isEstimate).toBe(false);

        expect(day2?.value).toBe(100);
        expect(day2?.isEstimate).toBe(true);
    });

    it('should return an empty array if attributes are empty or malformed', () => {
        expect(mapSuezAttributes({}, startDate, endDate)).toEqual([]);
        expect(mapSuezAttributes({ this_month_consumption: {} }, startDate, endDate)).toEqual([]);
    });
});
