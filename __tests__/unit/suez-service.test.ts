/**
 * Suez Water Integration Service Unit Tests
 * Verifies fallback to history when sensor is unavailable, and fallback price mapping.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getSuezData } from '@/lib/integrations/suez/service';
import { haGet } from '@/lib/haClient';

// Mock haGet
const mockHaGet = vi.mocked(haGet);

describe('Suez Service (getSuezData)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('reads the sensors named after SUEZ_COUNTER_ID', async () => {
        vi.stubEnv('SUEZ_COUNTER_ID', '777');
        mockHaGet.mockResolvedValue({ ok: false, status: 502, duration: 1, data: null } as never);
        await getSuezData(new Date('2026-03-01T00:00:00Z'), new Date('2026-03-10T00:00:00Z'));
        expect(mockHaGet).toHaveBeenCalledWith('/api/states/sensor.777_prix_de_l_eau');
        expect(mockHaGet).toHaveBeenCalledWith('/api/states/sensor.777_consommation_d_eau_hier');
    });

    it('returns no data and calls nothing without SUEZ_COUNTER_ID', async () => {
        vi.stubEnv('SUEZ_COUNTER_ID', '');
        const result = await getSuezData();
        expect(result).toEqual({ dailyConsumption: [], price: 2.74 });
        expect(mockHaGet).not.toHaveBeenCalled();
    });

    it('should query current state and price, and map data successfully', async () => {
        // Mock current price call
        mockHaGet.mockResolvedValueOnce({
            ok: true,
            status: 200,
            duration: 5,
            data: {
                entity_id: 'sensor.1234567890_prix_de_l_eau',
                state: '3.14',
                attributes: {},
            }
        });

        // Mock current consumption state call (valid)
        mockHaGet.mockResolvedValueOnce({
            ok: true,
            status: 200,
            duration: 5,
            data: {
                entity_id: 'sensor.1234567890_consommation_d_eau_hier',
                state: '150.0',
                attributes: {
                    this_month_consumption: {
                        '2026-06-01': 120
                    },
                    history: {
                        '2026-05': 3100
                    }
                }
            }
        });

        const start = new Date('2026-05-30T00:00:00Z');
        const end = new Date('2026-06-02T23:59:59Z');

        const result = await getSuezData(start, end);

        expect(result.price).toBe(3.14);
        expect(result.dailyConsumption.length).toBeGreaterThan(0);
        // Expect haGet to have been called twice (once for price, once for current state)
        expect(mockHaGet).toHaveBeenCalledTimes(2);
    });

    it('should fallback to default price if price sensor fails', async () => {
        // Price sensor fails
        mockHaGet.mockResolvedValueOnce({
            ok: false,
            status: 404,
            duration: 5,
            data: null
        });

        // Consumption state works
        mockHaGet.mockResolvedValueOnce({
            ok: true,
            status: 200,
            duration: 5,
            data: {
                entity_id: 'sensor.1234567890_consommation_d_eau_hier',
                state: '150.0',
                attributes: {
                    this_month_consumption: {
                        '2026-06-01': 120
                    }
                }
            }
        });

        const start = new Date('2026-06-01T00:00:00Z');
        const end = new Date('2026-06-02T23:59:59Z');

        const result = await getSuezData(start, end);

        expect(result.price).toBe(2.74); // Fallback price
        expect(result.dailyConsumption).toHaveLength(1);
    });

    it('should query history fallback if current consumption state is unavailable', async () => {
        // Price sensor works
        mockHaGet.mockResolvedValueOnce({
            ok: true,
            status: 200,
            duration: 5,
            data: {
                entity_id: 'sensor.1234567890_prix_de_l_eau',
                state: '2.50',
                attributes: {},
            }
        });

        // Current consumption is unavailable
        mockHaGet.mockResolvedValueOnce({
            ok: true,
            status: 200,
            duration: 5,
            data: {
                entity_id: 'sensor.1234567890_consommation_d_eau_hier',
                state: 'unavailable',
                attributes: {}
            }
        });

        // Mock history query response
        mockHaGet.mockResolvedValueOnce({
            ok: true,
            status: 200,
            duration: 10,
            data: [
                [
                    {
                        state: 'unavailable',
                        attributes: {},
                        last_updated: '2026-06-05T01:00:00Z'
                    },
                    {
                        state: '300.0',
                        attributes: {
                            this_month_consumption: {
                                '2026-06-01': 300
                            }
                        },
                        last_updated: '2026-06-04T12:00:00Z'
                    }
                ]
            ]
        });

        const start = new Date('2026-06-01T00:00:00Z');
        const end = new Date('2026-06-02T23:59:59Z');

        const result = await getSuezData(start, end);

        expect(result.price).toBe(2.50);
        expect(result.dailyConsumption).toHaveLength(1);
        expect(result.dailyConsumption[0].value).toBe(300);
        // Expect haGet to have been called 3 times (price, current state, history)
        expect(mockHaGet).toHaveBeenCalledTimes(3);
        expect(mockHaGet.mock.calls[2][0]).toContain('/api/history/period/');
    });
});
