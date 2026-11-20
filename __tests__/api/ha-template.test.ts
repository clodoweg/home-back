import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST } from '@/app/api/ha/template/route';
import { setMockUser, clearMockUsers } from '../setup';
import { mockAsAdmin, mockAsChildren, mockAsUnauthenticated, mockAsUser } from '../helpers/mock-auth';
import { ADMIN_USER, CHILDREN_USER, STANDARD_USER } from '../helpers/test-users';
import { logger } from '@/lib/logger';
import { resetHAMocks, mockHaPost } from '../helpers/mock-ha';

const params = Promise.resolve({});

describe('POST /api/ha/template', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
        resetHAMocks();

        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
    });

    it('returns 401 if unauthenticated', async () => {
        mockAsUnauthenticated();
        const req = new Request('http://localhost:3000/api/ha/template', {
            method: 'POST',
            body: JSON.stringify({ template: '{{ states("light.salon") }}' }),
        });
        const res = await POST(req, { params });
        expect(res.status).toBe(401);
    });

    it('returns 400 on schema validation failure', async () => {
        const req = new Request('http://localhost:3000/api/ha/template', {
            method: 'POST',
            body: JSON.stringify({}), // missing template field
        });
        const res = await POST(req, { params });
        expect(res.status).toBe(400);
    });

    it('executes template and returns plain text result', async () => {
        mockHaPost.mockResolvedValue({ data: 'on', ok: true, status: 200, duration: 10 });

        const req = new Request('http://localhost:3000/api/ha/template', {
            method: 'POST',
            body: JSON.stringify({ template: '{{ states("light.unique_a") }}' }),
        });

        const res = await POST(req, { params });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/plain');
        const text = await res.text();
        expect(text).toBe('on');
    });

    it('returns cached result for repeated identical template calls', async () => {
        mockHaPost.mockResolvedValue({ data: '21.5', ok: true, status: 200, duration: 10 });

        const body = JSON.stringify({ template: '{{ states("sensor.unique_cached_temp") }}' });

        const req1 = new Request('http://localhost:3000/api/ha/template', { method: 'POST', body });
        await POST(req1, { params });

        const req2 = new Request('http://localhost:3000/api/ha/template', { method: 'POST', body });
        const res2 = await POST(req2, { params });

        expect(res2.status).toBe(200);
        // haPost should only be called once (second call served from cache)
        expect(mockHaPost).toHaveBeenCalledTimes(1);
    });

    it('returns 502 if HA template execution fails', async () => {
        mockHaPost.mockResolvedValue({ data: null, ok: false, status: 422, duration: 10 });

        const req = new Request('http://localhost:3000/api/ha/template', {
            method: 'POST',
            body: JSON.stringify({ template: '{{ invalid_template_unique_b }}' }),
        });

        const res = await POST(req, { params });
        expect(res.status).toBe(502);
    });

    it.each([
        ['children', mockAsChildren, CHILDREN_USER],
        ['user', mockAsUser, STANDARD_USER],
    ] as const)('refuses the %s group with 403 and a security log, without calling HA (R1)', async (group, login, user) => {
        login();
        setMockUser(user.clerkId, user);
        mockHaPost.mockResolvedValue({ data: 'off', ok: true, status: 200, duration: 10 });

        const req = new Request('http://localhost:3000/api/ha/template', {
            method: 'POST',
            body: JSON.stringify({ template: '{{ states.person | list }}' }),
        });

        const res = await POST(req, { params });
        expect(res.status).toBe(403);
        expect(mockHaPost).not.toHaveBeenCalled();
        expect(logger.security).toHaveBeenCalledWith('Blocked HA template', expect.objectContaining({ group, templateLength: 26 }));
    });
});

describe('POST /api/ha/template — bounded cache (P09)', () => {
    const render = (template: string) =>
        POST(new Request('http://localhost:3000/api/ha/template', { method: 'POST', body: JSON.stringify({ template }) }), {
            params: Promise.resolve({}),
        });

    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
        resetHAMocks();
        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
        mockHaPost.mockResolvedValue({ ok: true, status: 200, duration: 1, data: 'rendered' });
    });

    it('serves a repeated template from the cache, and evicts the oldest beyond 200 entries', async () => {
        const first = `{{ "cache-test-${Date.now()}" }}`;
        await render(first);
        await render(first);
        expect(mockHaPost).toHaveBeenCalledTimes(1);

        for (let i = 0; i < 200; i++) await render(`{{ ${i} }} ${first}`);
        mockHaPost.mockClear();

        await render(first);
        expect(mockHaPost).toHaveBeenCalledTimes(1);
    });
});
