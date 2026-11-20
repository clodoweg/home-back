import { describe, it, expect } from 'vitest';
import { parseRawSchedule } from '@/lib/integrations/petkit';

describe('PetkitApiService.parseRawSchedule', () => {
    it('correctly parses user provided raw schedule string', () => {
        const raw = "0,7,0,5,6,1,11,0,5,1,2,14,6,1,2,3,14,6,1,2,4,17,0,5,1";
        const result = parseRawSchedule(raw);

        // Analysis of raw data:
        // 0: 07:00 -> Amount 5, Bac 6 (Ratio, default ratio1=1 => r1=5)
        // 1: 11:00 -> Amount 5, Bac 1 (Explicit tank 1? In our code 1 is r2)
        // 2: 14:06 -> Amount 1, Bac 2 (Ratio => r1=1)
        // 3: 14:06 -> Amount 1, Bac 2 (Ratio => r1=1)
        // 4: 17:00 -> Amount 5, Bac 1 (r2=5)
        
        // Sum R1: 5 + 0 + 1 + 1 + 0 = 7
        // Sum R2: 0 + 5 + 0 + 0 + 5 = 10
        // Total = 17

        expect(result.planAmountTotal1).toBe(7);
        expect(result.planAmountTotal2).toBe(10);
        expect(result.planAmountTotal1 + result.planAmountTotal2).toBe(17);
        
        expect(result.scheduleItems[0].items).toHaveLength(5);
        expect(result.scheduleItems[0].items[0].amount1).toBe(5);
    });

    it('handles empty or malformed strings', () => {
        expect(parseRawSchedule("")).toEqual({ scheduleItems: [], planAmountTotal1: 0, planAmountTotal2: 0 });
        // A missing HA state arrives as null at runtime
        expect(parseRawSchedule(null as unknown as string)).toEqual({ scheduleItems: [], planAmountTotal1: 0, planAmountTotal2: 0 });
    });
});
