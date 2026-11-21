import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '@/app/api/ha/states/route';
import { setMockUser, clearMockUsers } from '../setup';
import { mockAsAdmin, mockAsChildren, mockAsUnauthenticated } from '../helpers/mock-auth';
import { ADMIN_USER, CHILDREN_USER } from '../helpers/test-users';
import { mockHAStates, resetHAMocks } from '../helpers/mock-ha';
import { resetStatesCache } from '@/lib/ha-states-cache';

const params = Promise.resolve({});

describe('GET /api/ha/states', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
        resetHAMocks();
        // The states are cached 5 s: each test reads its own
        resetStatesCache();
    });

    it('returns 401 if unauthenticated', async () => {
        mockAsUnauthenticated();
        const req = new Request('http://localhost:3000/api/ha/states');
        const res = await GET(req, { params });
        expect(res.status).toBe(401);
    });

    it('admin sees all states including cameras', async () => {
        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);

        mockHAStates([
            { entity_id: 'light.salon', state: 'on' },
            { entity_id: 'camera.jardin', state: 'idle' },
        ]);

        const req = new Request('http://localhost:3000/api/ha/states');
        const res = await GET(req, { params });

        expect(res.status).toBe(200);
        const data = await res.json();

        // Assertions are wrapped in ApiResponse so data is at root
        expect(data).toHaveLength(2);
        expect(data[1].entity_id).toBe('camera.jardin');
    });

    it('children have cameras filtered out', async () => {
        mockAsChildren();
        setMockUser(CHILDREN_USER.clerkId, CHILDREN_USER);

        mockHAStates([
            { entity_id: 'light.salon', state: 'on' },
            { entity_id: 'camera.jardin', state: 'idle' },
        ]);

        const req = new Request('http://localhost:3000/api/ha/states');
        const res = await GET(req, { params });

        expect(res.status).toBe(200);
        const data = await res.json();

        expect(data).toHaveLength(1);
        expect(data[0].entity_id).toBe('light.salon');
    });

    it('never sends GPS positions nor camera access tokens, even to an admin (audit M1)', async () => {
        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);

        mockHAStates([
            { entity_id: 'zone.home', state: '2', attributes: { friendly_name: 'Maison', latitude: 48.85, longitude: 2.35, radius: 100 } },
            { entity_id: 'camera.jardin', state: 'idle', attributes: { access_token: 'secret', entity_picture: '/api/camera_proxy/camera.jardin?token=secret' } },
        ]);

        const res = await GET(new Request('http://localhost:3000/api/ha/states'), { params });
        const body = JSON.stringify(await res.json());

        expect(res.status).toBe(200);
        expect(body).toContain('"radius":100');
        expect(body).not.toContain('48.85');
        expect(body).not.toContain('secret');
    });
});
