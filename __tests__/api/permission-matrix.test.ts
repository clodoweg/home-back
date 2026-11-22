/**
 * Permission matrix — locks the CURRENT rights of each group on each route (audit T04).
 * Users carry the default group permissions created by lib/user.ts. A change here is a
 * change of the rights model and must be deliberate. Known risks of the October 2026 audit
 * (R2–R8, report kept out of the repository) are locked as they are, not fixed; R1 (free templates) is fixed: admin group only.
 * Since November 2026 every action on the house (HA service calls, camera capture, feeder; R2
 * fixed) is admin only: the owner is the only person who acts on the house.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { auth } from '@clerk/nextjs/server';
import { headers } from 'next/headers';
import { DEFAULT_GROUPS } from '@/lib/user';
import { setMockUser, clearMockUsers } from '../setup';
import { mockHaFetch, mockHaGet, mockHaPost, resetHAMocks } from '../helpers/mock-ha';

vi.mock('@/lib/integrations/enedis', () => ({ getEnedisData: vi.fn().mockResolvedValue({ dailyConsumption: [], dailyMaxPower: [], loadCurve: [] }) }));
vi.mock('@/lib/integrations/grdf', () => ({ getGrdfData: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/integrations/suez', () => ({ getSuezData: vi.fn().mockResolvedValue({ dailyConsumption: [], price: 0 }) }));
vi.mock('@/lib/integrations/ha-statistics', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/integrations/ha-statistics')>()),
    getStatistics: vi.fn().mockResolvedValue({}),
}));
vi.mock('@/lib/integrations/daily-usage', () => ({ getDailyUsage: vi.fn().mockResolvedValue({}) }));
vi.mock('@/lib/ha-states-cache', () => ({ getCachedStates: vi.fn() }));
vi.mock('@/lib/integrations/petkit', () => ({
    getFormattedPetkitData: vi.fn().mockResolvedValue({ devices: [], records: [], fountains: [] }),
    triggerFeederManual: vi.fn().mockResolvedValue(true),
}));

const { getCachedStates } = await import('@/lib/ha-states-cache');
const { GET: userMe } = await import('@/app/api/user/me/route');
const { GET: userPreferences } = await import('@/app/api/user/preferences/route');
const { GET: haStates } = await import('@/app/api/ha/states/route');
const { GET: haScenes } = await import('@/app/api/ha/scenes/route');
const { POST: haTemplate } = await import('@/app/api/ha/template/route');
const { GET: haMetadata } = await import('@/app/api/ha/metadata/route');
const { GET: haForecast } = await import('@/app/api/ha/forecast/route');
const { POST: haCall } = await import('@/app/api/ha/call/route');
const { GET: haHistory } = await import('@/app/api/ha/history/[[...slug]]/route');
const { GET: haImage } = await import('@/app/api/ha/image/[entity_id]/route');
const { GET: haMedia } = await import('@/app/api/ha/media/route');
const { POST: savePreferences } = await import('@/app/api/user/preferences/route');
const { GET: cameraImage } = await import('@/app/api/camera_proxy_image/[entity_id]/route');
const { POST: arloSnapshot } = await import('@/app/api/arlo/snapshot/[entity_id]/route');
const { GET: enedisData } = await import('@/app/api/enedis/data/route');
const { GET: grdf } = await import('@/app/api/grdf/route');
const { GET: suez } = await import('@/app/api/suez/route');
const { GET: petkit } = await import('@/app/api/petkit/route');
const { GET: haStatistics } = await import('@/app/api/ha/statistics/route');
const { GET: historyUsage } = await import('@/app/api/history/usage/route');
const { POST: petkitFeed } = await import('@/app/api/petkit/feed/route');

type Group = 'admin' | 'user' | 'children';

// Imported from the provisioning code, so a change of the defaults shows up here
const DEFAULT_PERMISSIONS = Object.fromEntries(DEFAULT_GROUPS.map(g => [g.name, g.permissions])) as Record<Group, string[]>;

const makeUser = (group: Group, id: number) => ({
    id,
    clerkId: `clerk_matrix_${group}`,
    email: `${group}@matrix.home`,
    group,
    widgetPreferences: {},
    createdAt: new Date('2024-01-01'),
    userGroup: { name: group, permissions: DEFAULT_PERMISSIONS[group] },
});

const USERS: Record<Group, ReturnType<typeof makeUser>> = {
    admin: makeUser('admin', 1),
    user: makeUser('user', 2),
    children: makeUser('children', 3),
};

type Handler = (request: Request, context: { params: Promise<any> }) => Promise<Response>;

interface RouteCase {
    name: string;
    handler: Handler;
    url: string;
    method?: 'GET' | 'POST';
    body?: unknown;
    params?: Record<string, unknown>;
    /** Expected status per group, as the code behaves today. */
    expected: Record<Group, number>;
}

const ALL_OK = { admin: 200, user: 200, children: 200 };
const ADMIN_ONLY = { admin: 200, user: 403, children: 403 };

const ROUTES: RouteCase[] = [
    { name: 'GET user/me', handler: userMe, url: '/api/user/me', expected: ALL_OK },
    { name: 'GET user/preferences', handler: userPreferences, url: '/api/user/preferences', expected: ALL_OK },
    { name: 'POST user/preferences', handler: savePreferences, url: '/api/user/preferences', method: 'POST', body: { theme: 'dark' }, expected: ALL_OK },
    { name: 'GET ha/states', handler: haStates, url: '/api/ha/states', expected: ALL_OK },
    { name: 'GET ha/scenes', handler: haScenes, url: '/api/ha/scenes', expected: ALL_OK },
    { name: 'GET ha/metadata', handler: haMetadata, url: '/api/ha/metadata', expected: ALL_OK },
    { name: 'GET ha/forecast', handler: haForecast, url: '/api/ha/forecast?entity_id=weather.maison&type=daily', expected: ALL_OK },
    // R1 fixed: free Jinja runs with the HA admin token, admin group only
    { name: 'POST ha/template', handler: haTemplate, url: '/api/ha/template', method: 'POST', body: { template: '{{ 1 }}' }, expected: ADMIN_ONLY },
    { name: 'POST ha/call light', handler: haCall, url: '/api/ha/call', method: 'POST', body: { domain: 'light', service: 'turn_on', entity_id: 'light.salon' }, expected: ADMIN_ONLY },
    { name: 'POST ha/call lock', handler: haCall, url: '/api/ha/call', method: 'POST', body: { domain: 'lock', service: 'unlock', entity_id: 'lock.porte' }, expected: ADMIN_ONLY },
    { name: 'POST ha/call camera entity', handler: haCall, url: '/api/ha/call', method: 'POST', body: { domain: 'camera', service: 'turn_off', entity_id: 'camera.aarlo_salon' }, expected: ADMIN_ONLY },
    { name: 'POST ha/call script', handler: haCall, url: '/api/ha/call', method: 'POST', body: { domain: 'script', service: 'turn_on', entity_id: 'script.coucher' }, expected: ADMIN_ONLY },
    { name: 'POST ha/call automation', handler: haCall, url: '/api/ha/call', method: 'POST', body: { domain: 'automation', service: 'trigger', entity_id: 'automation.desarmement' }, expected: ADMIN_ONLY },
    { name: 'POST ha/call alarm', handler: haCall, url: '/api/ha/call', method: 'POST', body: { domain: 'alarm_control_panel', service: 'alarm_disarm', entity_id: 'alarm_control_panel.maison' }, expected: ADMIN_ONLY },
    // audit M-1: a non-admin must not reach a sensitive entity through a mismatched/generic domain
    { name: 'POST ha/call alarm via mismatched domain', handler: haCall, url: '/api/ha/call', method: 'POST', body: { domain: 'switch', service: 'turn_off', entity_id: 'alarm_control_panel.maison' }, expected: ADMIN_ONLY },
    { name: 'GET ha/history', handler: haHistory, url: '/api/ha/history?entity_id=sensor.t&start_time=2026-01-01T00:00:00.000Z&end_time=2026-01-02T00:00:00.000Z', params: { slug: [] }, expected: ADMIN_ONLY },
    { name: 'GET ha/statistics', handler: haStatistics, url: '/api/ha/statistics?statistic_ids=sensor.t&start=2026-01-01T00:00:00.000Z&end=2026-01-02T00:00:00.000Z&period=hour', expected: ADMIN_ONLY },
    { name: 'GET history/usage', handler: historyUsage, url: '/api/history/usage?start=2026-01-01&end=2026-01-31', expected: ADMIN_ONLY },
    // Petkit images: no permission check today
    { name: 'GET ha/image', handler: haImage, url: '/api/ha/image/image.croquettes_dernier_repas', params: { entity_id: 'image.croquettes_dernier_repas' }, expected: ALL_OK },
    { name: 'GET ha/media', handler: haMedia, url: `/api/ha/media?media_content_id=${encodeURIComponent('media-source://local/media/1/20260101/eat/snapshot/1_0800.jpg')}`, expected: ALL_OK },
    { name: 'GET camera_proxy_image', handler: cameraImage, url: '/api/camera_proxy_image/camera.aarlo_salon', params: { entity_id: 'camera.aarlo_salon' }, expected: ADMIN_ONLY },
    { name: 'POST arlo/snapshot', handler: arloSnapshot, url: '/api/arlo/snapshot/camera.aarlo_salon', method: 'POST', params: { entity_id: 'camera.aarlo_salon' }, expected: ADMIN_ONLY },
    { name: 'GET enedis/data', handler: enedisData, url: '/api/enedis/data', expected: ADMIN_ONLY },
    { name: 'GET suez', handler: suez, url: '/api/suez', expected: ADMIN_ONLY },
    // R3: gas data without history check (the sensor.gazpar state used to require it)
    { name: 'GET grdf', handler: grdf, url: '/api/grdf', expected: ALL_OK },
    { name: 'GET petkit', handler: petkit, url: '/api/petkit', expected: ALL_OK },
    // R2 fixed: feeding is an action on the house, admin only
    { name: 'POST petkit/feed', handler: petkitFeed, url: '/api/petkit/feed', method: 'POST', body: { deviceId: 1, amount1: 1 }, expected: ADMIN_ONLY },
];

function loginAs(group: Group) {
    const user = USERS[group];
    vi.mocked(auth).mockResolvedValue({ userId: user.clerkId, sessionClaims: { email: user.email } } as never);
    setMockUser(user.clerkId, user);
}

function buildRequest({ url, method = 'GET', body }: RouteCase) {
    return new Request(`http://localhost:3000${url}`, {
        method,
        ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
    });
}

async function callRoute(route: RouteCase) {
    const pending = route.handler(buildRequest(route), { params: Promise.resolve(route.params ?? {}) });
    await vi.runAllTimersAsync();
    return pending;
}

function mockUpstreamOk() {
    const ok = { ok: true, status: 200, duration: 1, data: [] as unknown };
    vi.mocked(getCachedStates).mockResolvedValue({ ok: true, data: [] });
    // Single-entity reads (camera_snapshot) need a state object, lists need an array
    mockHaFetch.mockImplementation((async (path: string) =>
        path.startsWith('/api/states/') ? { ...ok, data: { state: 'idle', attributes: { friendly_name: 'Salon' } } } : ok) as never);
    mockHaGet.mockResolvedValue(ok as never);
    // '{}' is a valid rendered metadata template and an empty service response
    mockHaPost.mockResolvedValue({ ...ok, data: '{}' } as never);
    vi.spyOn(global, 'fetch').mockImplementation(async () => new Response(Buffer.from('img'), { status: 200, headers: { 'content-type': 'image/jpeg' } }));
}

describe('Permission matrix (default group permissions, home network)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.restoreAllMocks();
        clearMockUsers();
        resetHAMocks();
        mockUpstreamOk();
        vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe.each(ROUTES)('$name', (route) => {
        it.each(['admin', 'user', 'children'] as Group[])('%s', async (group) => {
            loginAs(group);

            const res = await callRoute(route);

            expect(res.status).toBe(route.expected[group]);
            if (res.status === 403) {
                // A permission refusal, not the network restriction
                expect((await res.json()).code).not.toBe('IP_RESTRICTED');
            }
        });
    });

    it('hides camera entities from children in the states list', async () => {
        vi.mocked(getCachedStates).mockResolvedValue({ ok: true, data: [{ entity_id: 'camera.aarlo_salon', state: 'idle' }, { entity_id: 'light.salon', state: 'on' }] });

        for (const group of ['user', 'children'] as Group[]) {
            loginAs(group);
            const res = await haStates(new Request('http://localhost:3000/api/ha/states'), { params: Promise.resolve({}) });
            const ids = (await res.json()).map((s: { entity_id: string }) => s.entity_id);
            expect(ids.includes('camera.aarlo_salon')).toBe(group === 'user');
        }
    });

    it('serves the Petkit history only to groups with the history permission', async () => {
        const { getFormattedPetkitData } = await import('@/lib/integrations/petkit');

        for (const group of ['admin', 'user'] as Group[]) {
            loginAs(group);
            await petkit(new Request('http://localhost:3000/api/petkit'), { params: Promise.resolve({}) });
        }

        const calls = vi.mocked(getFormattedPetkitData).mock.calls;
        expect(calls.map(([, hasHistory]) => hasHistory)).toEqual([true, false]);
    });

    describe('off the home network', () => {
        beforeEach(() => {
            vi.mocked(headers).mockImplementation((async () => ({ get: (key: string) => (key === 'x-real-ip' ? '203.0.113.50' : null) })) as never);
        });

        it.each(ROUTES.map(route => [route.name, route] as const))('%s: only the remote permission gets through', async (_name, route) => {
            for (const group of ['user', 'children'] as Group[]) {
                loginAs(group);
                const res = await callRoute(route);
                expect(res.status).toBe(403);
                expect((await res.json()).code).toBe('IP_RESTRICTED');
            }

            loginAs('admin');
            expect((await callRoute(route)).status).toBe(route.expected.admin);
        });
    });
});
