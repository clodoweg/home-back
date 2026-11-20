import { describe, it, expect } from 'vitest';
import { getParisDayInt } from '@/lib/paris-time';

describe('Petkit Media Folder Stability', () => {
    it('should generate the correct Paris date string (yyyyMMdd) even on UTC environment', () => {
        // Instant: 2026-03-16 00:30:00 Paris (UTC+1)
        // This is 2026-03-15 23:30:00 UTC
        const utcDate = new Date(Date.UTC(2026, 2, 15, 23, 30));
        
        const dayInt = getParisDayInt(utcDate);
        expect(dayInt).toBe(20260316); // Business day is 16th
    });

    it('uses the Paris day around midnight', () => {
        // Instant: 2026-03-17 00:32:00 Paris (UTC+1), i.e. 2026-03-16 23:32:00 UTC
        const date = new Date(1773703920 * 1000);

        expect(getParisDayInt(date)).toBe(20260317);
    });

    it('should handle summer time transition correctly for date strings', () => {
        // Instant: 2026-07-16 01:30:00 Paris (UTC+2)
        // This is 2026-07-15 23:30:00 UTC
        const utcDate = new Date(Date.UTC(2026, 6, 15, 23, 30));
        
        const dayInt = getParisDayInt(utcDate);
        expect(dayInt).toBe(20260716); 
    });
});
