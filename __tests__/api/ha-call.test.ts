import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST } from '@/app/api/ha/call/route';
import { setMockUser, clearMockUsers } from '../setup';
import { mockAsChildren, mockAsAdmin, mockAsUser } from '../helpers/mock-auth';
import { ADMIN_USER, CHILDREN_USER, STANDARD_USER } from '../helpers/test-users';
import { mockHACallService, mockHAError, resetHAMocks } from '../helpers/mock-ha';
import { haPost } from '@/lib/haClient';

const params = Promise.resolve({});

describe('POST /api/ha/call', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
        resetHAMocks();

        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
    });

    it('validates schema and returns 400 on error', async () => {
        const payload = { domain: 'light' }; // Missing required fields
        const req = new Request('http://localhost:3000/api/ha/call', {
            method: 'POST',
            body: JSON.stringify(payload),
        });

        const res = await POST(req, { params });
        expect(res.status).toBe(400);
    });

    it('passes payload to HA and returns response', async () => {
        mockHACallService([{ entity_id: 'light.salon', state: 'on' }]);

        const payload = {
            domain: 'light',
            service: 'turn_on',
            entity_id: 'light.salon',
            service_data: { brightness: 255 },
        };

        const req = new Request('http://localhost:3000/api/ha/call', {
            method: 'POST',
            body: JSON.stringify(payload),
        });

        const res = await POST(req, { params });
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data[0].state).toBe('on');

        // Verify haPost arguments
        expect(haPost).toHaveBeenCalledWith(
            '/api/services/light/turn_on',
            { entity_id: 'light.salon', brightness: 255 },
            'call:light.turn_on'
        );
    });

    it('returns 502 if HA returns error', async () => {
        mockHAError(500);

        const payload = {
            domain: 'light',
            service: 'turn_on',
            entity_id: 'light.salon',
        };

        const req = new Request('http://localhost:3000/api/ha/call', {
            method: 'POST',
            body: JSON.stringify(payload),
        });

        const res = await POST(req, { params });
        expect(res.status).toBe(502);
    });
});

describe('POST /api/ha/call — target override (S09)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
        resetHAMocks();
        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
        mockHACallService({});
    });

    it('sends only the checked entity_id, whatever service_data contains', async () => {
        const req = new Request('http://localhost:3000/api/ha/call', {
            method: 'POST',
            body: JSON.stringify({
                domain: 'light',
                service: 'turn_off',
                entity_id: 'light.salon',
                service_data: {
                    entity_id: 'lock.porte_entree',
                    area_id: 'maison',
                    device_id: 'abc',
                    floor_id: 'rdc',
                    label_id: 'securite',
                    target: { entity_id: 'camera.aarlo_salon' },
                    transition: 2,
                },
            }),
        });

        const res = await POST(req, { params });

        expect(res.status).toBe(200);
        expect(haPost).toHaveBeenCalledWith(
            expect.stringContaining('/api/services/light/turn_off'),
            { entity_id: 'light.salon', transition: 2 },
            expect.any(String),
        );
    });

});

describe('POST /api/ha/call — the family runs the dashboard actions only', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
        resetHAMocks();
        mockHACallService({});
    });

    const callAs = (body: Record<string, unknown>) =>
        POST(new Request('http://localhost:3000/api/ha/call', { method: 'POST', body: JSON.stringify(body) }), { params });

    it('lets the user group and children run a dashboard action', async () => {
        mockAsUser();
        setMockUser(STANDARD_USER.clerkId, STANDARD_USER);
        expect((await callAs({ domain: 'light', service: 'turn_on', entity_id: 'light.salon' })).status).toBe(200);

        mockAsChildren();
        setMockUser(CHILDREN_USER.clerkId, CHILDREN_USER);
        expect((await callAs({ domain: 'scene', service: 'turn_on', entity_id: 'scene.soiree' })).status).toBe(200);
    });

    it.each([
        ['a lock', { domain: 'lock', service: 'unlock', entity_id: 'lock.porte_entree' }],
        ['a script', { domain: 'script', service: 'turn_on', entity_id: 'script.coucher' }],
        ['an automation', { domain: 'automation', service: 'trigger', entity_id: 'automation.desarmement' }],
        ['a garage door', { domain: 'cover', service: 'open_cover', entity_id: 'cover.garage' }],
    ])('refuses %s to the user group, even with the remote right', async (_label, body) => {
        mockAsUser();
        setMockUser(STANDARD_USER.clerkId, STANDARD_USER);

        expect((await callAs(body)).status).toBe(403);
        expect(haPost).not.toHaveBeenCalled();
    });
});
