/** GET /api/ha/metadata — fixed template, response shape, rights, HA errors, headers */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '@/app/api/ha/metadata/route';
import { ENTITY_METADATA_TEMPLATE, resetEntityMetadataCache } from '@/lib/integrations/ha-metadata';
import { setMockUser, clearMockUsers } from '../setup';
import { mockAsAdmin, mockAsChildren, mockAsUnauthenticated, mockAsUser } from '../helpers/mock-auth';
import { ADMIN_USER, CHILDREN_USER, STANDARD_USER } from '../helpers/test-users';
import { mockHAError, mockHaPost, resetHAMocks } from '../helpers/mock-ha';

const call = (url = 'http://localhost:3000/api/ha/metadata') => GET(new Request(url), { params: Promise.resolve({}) });

const RENDERED = JSON.stringify({
    'light.salon': { area: 'Salon "TV"', floor: 'RDC', model: 'Hue' },
    'sensor.t': { area: '', floor: '', model: '' },
});

describe('GET /api/ha/metadata', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
        resetHAMocks();
        resetEntityMetadataCache();
        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
    });

    it('returns 401 if unauthenticated', async () => {
        mockAsUnauthenticated();
        expect((await call()).status).toBe(401);
        expect(mockHaPost).not.toHaveBeenCalled();
    });

    it('renders the fixed template and returns the metadata map, private and not stored', async () => {
        mockHaPost.mockResolvedValue({ data: RENDERED, ok: true, status: 200, duration: 1 });

        const res = await call();

        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('private, no-store');
        expect(await res.json()).toEqual({
            'light.salon': { area: 'Salon "TV"', floor: 'RDC', model: 'Hue' },
            'sensor.t': { area: '', floor: '', model: '' },
        });
        expect(mockHaPost).toHaveBeenCalledWith('/api/template', { template: ENTITY_METADATA_TEMPLATE }, 'metadata');
    });

    it('ignores any client input: the template sent to HA never changes', async () => {
        mockHaPost.mockResolvedValue({ data: '{}', ok: true, status: 200, duration: 1 });

        await call('http://localhost:3000/api/ha/metadata?template={{states.person}}');

        expect(mockHaPost.mock.calls[0][1]).toEqual({ template: ENTITY_METADATA_TEMPLATE });
    });

    it.each([
        ['user', mockAsUser, STANDARD_USER],
        ['children', mockAsChildren, CHILDREN_USER],
    ] as const)('serves the %s group (same rights as ha/states)', async (_group, login, user) => {
        login();
        setMockUser(user.clerkId, user);
        mockHaPost.mockResolvedValue({ data: '{}', ok: true, status: 200, duration: 1 });

        expect((await call()).status).toBe(200);
    });

    it('serves repeated calls from the 5-minute cache', async () => {
        mockHaPost.mockResolvedValue({ data: RENDERED, ok: true, status: 200, duration: 1 });

        await call();
        await call();

        expect(mockHaPost).toHaveBeenCalledTimes(1);
    });

    it.each([401, 403, 500])('returns a generic 502 when HA answers %i', async (status) => {
        mockHAError(status);

        const res = await call();

        expect(res.status).toBe(502);
        expect((await res.json()).error).toBe('Failed to fetch metadata from Home Assistant');
    });

    it('returns 502 when the template renders invalid JSON', async () => {
        mockHaPost.mockResolvedValue({ data: '{ broken', ok: true, status: 200, duration: 1 });
        expect((await call()).status).toBe(502);
    });

    it('returns 502 when HA cannot be reached', async () => {
        mockHaPost.mockRejectedValue(new Error('timeout'));
        expect((await call()).status).toBe(502);
    });
});
