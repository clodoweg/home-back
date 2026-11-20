import { describe, it, expect } from 'vitest';
import { parseRawSchedule } from '@/lib/integrations/petkit';

describe('PetkitApiService Ration Logic', () => {
    describe('parseRawSchedule()', () => {
        it('should assign portions to Bac 1 when bacSelector is 0', () => {
            const raw = "1,7,0,5,0,2,11,0,5,0,3,17,0,4,0";
            const ratio1 = 0.4; 
            const ratio2 = 0.6;

            const { planAmountTotal1, planAmountTotal2 } = parseRawSchedule(raw, ratio1, ratio2);

            expect(planAmountTotal1 + planAmountTotal2).toBe(14);
            expect(planAmountTotal1).toBe(14); 
            expect(planAmountTotal2).toBe(0);
        });

        it('should assign portions to Bac 2 when bacSelector is 1', () => {
            const raw = "1,7,0,5,1,2,11,0,5,1";
            const ratio1 = 0.5;
            const ratio2 = 0.5;

            const { planAmountTotal1, planAmountTotal2 } = parseRawSchedule(raw, ratio1, ratio2);

            expect(planAmountTotal1).toBe(0);
            expect(planAmountTotal2).toBe(10);
        });

        it('should split portions according to ratio when bacSelector is 6 (Both)', () => {
            const raw = "1,7,0,10,6";
            const ratio1 = 0.4;
            const ratio2 = 0.6;

            const { planAmountTotal1, planAmountTotal2 } = parseRawSchedule(raw, ratio1, ratio2);

            expect(planAmountTotal1).toBe(4);
            expect(planAmountTotal2).toBe(6);
        });
    });
});

