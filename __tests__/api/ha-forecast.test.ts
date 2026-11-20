/** GET /api/ha/forecast — validation, entity rights, response shape, HA errors, headers */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '@/app/api/ha/forecast/route';
import { canCallHAService } from '@/lib/permissions';
import { logger } from '@/lib/logger';
import { setMockUser, clearMockUsers } from '../setup';
import { mockAsAdmin, mockAsChildren, mockAsUnauthenticated, mockAsUser } from '../helpers/mock-auth';
import { ADMIN_USER, CHILDREN_USER, STANDARD_USER } from '../helpers/test-users';
import { mockHAError, mockHaPost, resetHAMocks } from '../helpers/mock-ha';

vi.mock('@/lib/permissions', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/permissions')>();
    return { ...actual, canCallHAService: vi.fn(actual.canCallHAService) };
});

const call = (query: string) =>
    GET(new Request(`http://localhost:3000/api/ha/forecast${query}`), { params: Promise.resolve({}) });

const FORECAST = [
    { datetime: '2026-10-26T11:00:00+00:00', condition: 'sunny', temperature: 18, templow: 9 },
    { datetime: '2026-10-27T11:00:00+00:00', condition: 'rainy', temperature: 14, templow: 8 },
];

describe('GET /api/ha/forecast', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
        resetHAMocks();
        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
    });

    it('returns 401 if unauthenticated', async () => {
        mockAsUnauthenticated();
        expect((await call('?entity_id=weather.maison&type=daily')).status).toBe(401);
    });

    it('calls get_forecasts and returns the forecast array, private and not stored', async () => {
        mockHaPost.mockResolvedValue({
            data: { changed_states: [], service_response: { 'weather.maison': { forecast: FORECAST } } },
            ok: true,
            status: 200,
            duration: 1,
        });

        const res = await call('?entity_id=weather.maison&type=daily');

        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('private, no-store');
        expect(await res.json()).toEqual(FORECAST);
        expect(mockHaPost).toHaveBeenCalledWith(
            '/api/services/weather/get_forecasts?return_response=true',
            { entity_id: 'weather.maison', type: 'daily' },
            'forecast:daily',
        );
    });

    it('accepts the bare { <entity_id>: { forecast } } form', async () => {
        mockHaPost.mockResolvedValue({ data: { 'weather.maison': { forecast: FORECAST } }, ok: true, status: 200, duration: 1 });

        const res = await call('?entity_id=weather.maison&type=hourly');

        expect(await res.json()).toEqual(FORECAST);
        expect(mockHaPost.mock.calls[0][1]).toEqual({ entity_id: 'weather.maison', type: 'hourly' });
    });

    it('returns [] when HA has no forecast for the entity', async () => {
        mockHaPost.mockResolvedValue({ data: { service_response: {} }, ok: true, status: 200, duration: 1 });

        const res = await call('?entity_id=weather.maison&type=daily');

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual([]);
    });

    it.each([
        '',
        '?type=daily',
        '?entity_id=weather.maison',
        '?entity_id=weather.maison&type=weekly',
        '?entity_id=sensor.temperature&type=daily',
        '?entity_id=weather.x%2F..%2F..%2Fconfig&type=daily',
        '?entity_id=WEATHER.MAISON&type=daily',
    ])('returns 400 without calling HA for %s', async (query) => {
        const res = await call(query);

        expect(res.status).toBe(400);
        expect(mockHaPost).not.toHaveBeenCalled();
    });

    it.each([
        ['user', mockAsUser, STANDARD_USER],
        ['children', mockAsChildren, CHILDREN_USER],
    ] as const)('serves the %s group (weather is not a restricted domain)', async (_group, login, user) => {
        login();
        setMockUser(user.clerkId, user);
        mockHaPost.mockResolvedValue({ data: { service_response: { 'weather.maison': { forecast: FORECAST } } }, ok: true, status: 200, duration: 1 });

        expect((await call('?entity_id=weather.maison&type=daily')).status).toBe(200);
        expect(canCallHAService).toHaveBeenCalledWith(expect.objectContaining({ group: user.group }), 'weather', 'weather.maison');
    });

    it('returns 403 and logs a security event when the entity check refuses', async () => {
        vi.mocked(canCallHAService).mockReturnValueOnce(false);

        const res = await call('?entity_id=weather.maison&type=daily');

        expect(res.status).toBe(403);
        expect(logger.security).toHaveBeenCalledWith('Blocked weather forecast', expect.objectContaining({ entity_id: 'weather.maison' }));
        expect(mockHaPost).not.toHaveBeenCalled();
    });

    it.each([400, 401, 403, 500])('returns a generic 502 when HA answers %i', async (status) => {
        mockHAError(status);

        const res = await call('?entity_id=weather.maison&type=daily');

        expect(res.status).toBe(502);
        expect((await res.json()).error).toBe('Failed to fetch forecast from Home Assistant');
    });

    it('returns 502 when HA cannot be reached', async () => {
        mockHaPost.mockRejectedValue(new Error('timeout'));
        expect((await call('?entity_id=weather.maison&type=daily')).status).toBe(502);
    });
});
