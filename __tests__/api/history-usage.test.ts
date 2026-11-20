import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/history/usage/route';
import { getDailyUsage } from '@/lib/integrations/daily-usage';
import { setMockUser, clearMockUsers } from '../setup';
import { mockAsAdmin, mockAsUser } from '../helpers/mock-auth';
import { ADMIN_USER, STANDARD_USER } from '../helpers/test-users';

vi.mock('@/lib/integrations/daily-usage', () => ({ getDailyUsage: vi.fn() }));

const call = (query: string) => GET(new Request(`http://localhost:3000/api/history/usage?${query}`), { params: Promise.resolve({}) });

describe('GET /api/history/usage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
        vi.mocked(getDailyUsage).mockResolvedValue({ washer_cycles: [{ date: '2026-11-18', value: 1 }] });
    });

    it('returns 403 without the history permission', async () => {
        mockAsUser();
        setMockUser(STANDARD_USER.clerkId, STANDARD_USER);
        expect((await call('start=2026-11-01&end=2026-11-30')).status).toBe(403);
    });

    it('returns the series of the range', async () => {
        const res = await call('start=2026-11-01&end=2026-11-30');
        expect(res.status).toBe(200);
        expect(res.headers.get('Cache-Control')).toBe('private, no-store');
        expect(await res.json()).toEqual({ washer_cycles: [{ date: '2026-11-18', value: 1 }] });
        const [start, end, include] = vi.mocked(getDailyUsage).mock.calls[0];
        expect([start, end]).toEqual(['2026-11-01', '2026-11-30']);
        expect(include('motion:binary_sensor.aarlo_motion_a')).toBe(true);
    });

    it('hides the camera detections without the cameras right', async () => {
        setMockUser(ADMIN_USER.clerkId, { ...ADMIN_USER, group: 'family', userGroup: { name: 'family', permissions: ['history', 'remote'] } });
        await call('start=2026-11-01&end=2026-11-30');
        const include = vi.mocked(getDailyUsage).mock.calls[0][2];
        expect(include('motion:binary_sensor.aarlo_motion_a')).toBe(false);
        expect(include('washer_cycles')).toBe(true);
    });

    it.each([
        ['an invalid day', 'start=2026-11-1&end=2026-11-30'],
        ['a reversed range', 'start=2026-11-30&end=2026-11-01'],
        ['a range over 3 years', 'start=2020-01-01&end=2026-11-30'],
    ])('returns 400 for %s', async (_name, query) => {
        expect((await call(query)).status).toBe(400);
    });

    it('returns 500 when the database fails', async () => {
        vi.mocked(getDailyUsage).mockRejectedValue(new Error('db down'));
        expect((await call('start=2026-11-01&end=2026-11-30')).status).toBe(500);
    });
});
