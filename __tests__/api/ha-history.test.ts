import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '@/app/api/ha/history/[[...slug]]/route';
import { setMockUser, clearMockUsers } from '../setup';
import { mockAsAdmin, mockAsUser, mockAsUnauthenticated } from '../helpers/mock-auth';
import { ADMIN_USER, STANDARD_USER } from '../helpers/test-users';
import { mockHAFetchResponse, mockHAError, resetHAMocks, mockHaFetch } from '../helpers/mock-ha';

const noSlug = Promise.resolve({ slug: [] });
const withSlug = (slug: string[]) => Promise.resolve({ slug });

const HISTORY_FIXTURE = [[{ entity_id: 'sensor.temp', state: '21.5', last_changed: '2026-01-01T00:00:00Z' }]];

describe('GET /api/ha/history', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
        resetHAMocks();
    });

    it('returns 401 if unauthenticated', async () => {
        mockAsUnauthenticated();
        const req = new Request('http://localhost:3000/api/ha/history');
        const res = await GET(req, { params: noSlug });
        expect(res.status).toBe(401);
    });

    it('returns 403 for user without history permission', async () => {
        mockAsUser();
        setMockUser(STANDARD_USER.clerkId, STANDARD_USER);

        const req = new Request('http://localhost:3000/api/ha/history');
        const res = await GET(req, { params: noSlug });

        expect(res.status).toBe(403);
    });

    it('returns history data in simplified format (entity_id + start_time + end_time)', async () => {
        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
        mockHAFetchResponse(HISTORY_FIXTURE);

        const req = new Request(
            'http://localhost:3000/api/ha/history' +
            '?entity_id=sensor.temp&start_time=2026-01-01T00:00:00.000Z&end_time=2026-01-02T00:00:00.000Z'
        );
        const res = await GET(req, { params: noSlug });

        expect(res.status).toBe(200);
        const body = await res.json();
        // ApiResponse.success() returns data directly (no wrapper)
        expect(body).toEqual(HISTORY_FIXTURE);

        // Verify HA was called with the simplified path format
        expect(mockHaFetch).toHaveBeenCalledWith(
            expect.stringContaining('/api/history/period/'),
            expect.any(Object)
        );
    });

    it('returns history data in full format (with slug)', async () => {
        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
        mockHAFetchResponse(HISTORY_FIXTURE);

        const req = new Request(
            'http://localhost:3000/api/ha/history/period/2026-01-01T00:00:00.000Z?filter_entity_id=sensor.temp'
        );
        const res = await GET(req, { params: withSlug(['period', '2026-01-01T00:00:00.000Z']) });

        expect(res.status).toBe(200);
        expect(mockHaFetch).toHaveBeenCalledWith(
            expect.stringContaining('/api/history/period/2026-01-01T00%3A00%3A00.000Z?filter_entity_id=sensor.temp'),
            expect.any(Object)
        );
    });

    it('returns error if HA is unreachable', async () => {
        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
        mockHAError(502);

        const req = new Request(
            'http://localhost:3000/api/ha/history' +
            '?entity_id=sensor.temp&start_time=2026-01-01T00:00:00.000Z&end_time=2026-01-02T00:00:00.000Z'
        );
        const res = await GET(req, { params: noSlug });

        expect(res.status).toBe(502);
    });

    it.each([401, 403, 404, 500])('returns a generic 502 when HA answers %i (never a fake session error)', async (status) => {
        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
        mockHAError(status);

        const req = new Request(
            'http://localhost:3000/api/ha/history' +
            '?entity_id=sensor.temp&start_time=2026-01-01T00:00:00.000Z&end_time=2026-01-02T00:00:00.000Z'
        );
        const res = await GET(req, { params: noSlug });

        expect(res.status).toBe(502);
        expect((await res.json()).error).toBe('Home Assistant API error');
    });
});

describe('GET /api/ha/history — security regressions (S06)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
        resetHAMocks();
        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
    });

    it.each([
        [['..', 'config'], 'filter_entity_id=sensor.temp'],
        [['period', '../../config'], 'filter_entity_id=sensor.temp'],
        [['states'], ''],
        [['period', '2026-01-01T00:00:00.000Z'], 'filter_entity_id=sensor.temp/../../config'],
    ])('rejects slug %j with query "%s" without calling HA', async (slug, query) => {
        const res = await GET(new Request(`http://localhost:3000/api/ha/history/x?${query}`), { params: withSlug(slug) });

        expect(res.status).toBe(400);
        expect(mockHaFetch).not.toHaveBeenCalled();
    });

    it('does not echo internal error messages', async () => {
        mockHaFetch.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.2:8123'));

        const res = await GET(
            new Request('http://localhost:3000/api/ha/history?entity_id=sensor.temp&start_time=2026-01-01T00:00:00.000Z&end_time=2026-01-02T00:00:00.000Z'),
            { params: noSlug },
        );

        expect(res.status).toBe(500);
        expect(JSON.stringify(await res.json())).not.toContain('ECONNREFUSED');
    });

    it('removes the GPS trail from a device tracker history (audit M1)', async () => {
        mockHAFetchResponse([[
            { entity_id: 'device_tracker.phone', state: 'away', attributes: { friendly_name: 'Phone', latitude: 48.85, longitude: 2.35 } },
        ]]);

        const res = await GET(
            new Request('http://localhost:3000/api/ha/history?entity_id=device_tracker.phone&start_time=2026-01-01T00:00:00.000Z&end_time=2026-01-02T00:00:00.000Z'),
            { params: noSlug },
        );

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual([[{ entity_id: 'device_tracker.phone', state: 'away', attributes: { friendly_name: 'Phone' } }]]);
    });
});
