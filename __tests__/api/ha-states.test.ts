import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '@/app/api/ha/states/route';
import { setMockUser, clearMockUsers } from '../setup';
import { mockAsAdmin, mockAsChildren, mockAsUnauthenticated } from '../helpers/mock-auth';
import { ADMIN_USER, CHILDREN_USER } from '../helpers/test-users';
import { mockHAStates, resetHAMocks } from '../helpers/mock-ha';

const params = Promise.resolve({});

describe('GET /api/ha/states', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
        resetHAMocks();
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
});
