import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/ha/statistics/route';
import { haWebSocketCommand } from '@/lib/ha-websocket';
import { setMockUser, clearMockUsers } from '../setup';
import { mockAsAdmin, mockAsUser } from '../helpers/mock-auth';
import { ADMIN_USER, STANDARD_USER } from '../helpers/test-users';

vi.mock('@/lib/ha-websocket', () => ({ haWebSocketCommand: vi.fn() }));

const noParams = { params: Promise.resolve({}) };
const call = (query: string) => GET(new Request(`http://localhost:3000/api/ha/statistics?${query}`), noParams);
const VALID = 'statistic_ids=sensor.salon_temperature,sensor.cave_temperature&start=2026-11-01T00:00:00.000Z&end=2026-11-08T00:00:00.000Z&period=hour';

describe('GET /api/ha/statistics', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
    });

    it('returns 403 without the history permission', async () => {
        mockAsUser();
        setMockUser(STANDARD_USER.clerkId, STANDARD_USER);
        const res = await call(VALID);
        expect(res.status).toBe(403);
        expect(haWebSocketCommand).not.toHaveBeenCalled();
    });

    it('asks HA for the statistics and normalizes the rows', async () => {
        vi.mocked(haWebSocketCommand).mockResolvedValue({
            'sensor.salon_temperature': [
                { start: Date.parse('2026-11-01T00:00:00Z'), end: 0, mean: 20.5, min: 20, max: 21, last_reset: null },
                { start: '2026-11-01T01:00:00+00:00', mean: 20.1 },
            ],
            'sensor.broken': 'not rows',
        });

        const res = await call(`${VALID}&types=mean,max`);

        expect(res.status).toBe(200);
        expect(res.headers.get('Cache-Control')).toBe('private, no-store');
        expect(await res.json()).toEqual({
            'sensor.salon_temperature': [
                { start: '2026-11-01T00:00:00.000Z', mean: 20.5, max: 21 },
                { start: '2026-11-01T01:00:00.000Z', mean: 20.1 },
            ],
        });
        expect(haWebSocketCommand).toHaveBeenCalledWith(
            {
                type: 'recorder/statistics_during_period',
                start_time: '2026-11-01T00:00:00.000Z',
                end_time: '2026-11-08T00:00:00.000Z',
                statistic_ids: ['sensor.salon_temperature', 'sensor.cave_temperature'],
                period: 'hour',
                types: ['mean', 'max'],
            },
            'statistics',
        );
    });

    it('asks for mean, min, max and change by default and survives an empty answer', async () => {
        vi.mocked(haWebSocketCommand).mockResolvedValue(null);
        const res = await call(VALID);
        expect(await res.json()).toEqual({});
        expect(vi.mocked(haWebSocketCommand).mock.calls[0][0].types).toEqual(['mean', 'min', 'max', 'change']);
    });

    it.each([
        ['an invalid entity id', VALID.replace('sensor.cave_temperature', '../states')],
        ['an unknown period', VALID.replace('period=hour', 'period=minute')],
        ['an unknown type', `${VALID}&types=mean,state`],
        ['a reversed window', 'statistic_ids=sensor.t&start=2026-11-08T00:00:00Z&end=2026-11-01T00:00:00Z&period=day'],
        ['hours over two months', 'statistic_ids=sensor.t&start=2026-09-01T00:00:00Z&end=2026-11-01T00:00:00Z&period=hour'],
        ['a missing start', 'statistic_ids=sensor.t&end=2026-11-01T00:00:00Z&period=day'],
    ])('returns 400 for %s', async (_name, query) => {
        const res = await call(query);
        expect(res.status).toBe(400);
        expect(haWebSocketCommand).not.toHaveBeenCalled();
    });

    it('accepts months over several years', async () => {
        vi.mocked(haWebSocketCommand).mockResolvedValue({});
        const res = await call('statistic_ids=sensor.t&start=2022-01-01T00:00:00Z&end=2026-11-01T00:00:00Z&period=month');
        expect(res.status).toBe(200);
    });

    it('returns a generic 502 when HA fails', async () => {
        vi.mocked(haWebSocketCommand).mockRejectedValue(new Error('auth refused'));
        const res = await call(VALID);
        expect(res.status).toBe(502);
        expect(JSON.stringify(await res.json())).not.toContain('auth refused');
    });
});
