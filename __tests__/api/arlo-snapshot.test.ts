import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST } from '@/app/api/arlo/snapshot/[entity_id]/route';
import { setMockUser, clearMockUsers } from '../setup';
import { mockAsAdmin, mockAsChildren, mockAsUnauthenticated } from '../helpers/mock-auth';
import { ADMIN_USER, CHILDREN_USER } from '../helpers/test-users';
import { mockHACallService, mockHAError, resetHAMocks, mockHaPost } from '../helpers/mock-ha';

const makeParams = (entity_id: string) => Promise.resolve({ entity_id });

describe('POST /api/arlo/snapshot/[entity_id]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
        resetHAMocks();
    });

    it('returns 401 if unauthenticated', async () => {
        mockAsUnauthenticated();
        const req = new Request('http://localhost:3000/api/arlo/snapshot/camera.aarlo_salon', {
            method: 'POST',
        });
        const res = await POST(req, { params: makeParams('camera.aarlo_salon') });
        expect(res.status).toBe(401);
    });

    it('returns 400 if entity_id is not a camera.aarlo_* entity', async () => {
        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);

        const req = new Request('http://localhost:3000/api/arlo/snapshot/camera.jardin', {
            method: 'POST',
        });
        const res = await POST(req, { params: makeParams('camera.jardin') });
        expect(res.status).toBe(400);
    });

    it('returns 403 for children (no camera permission)', async () => {
        mockAsChildren();
        setMockUser(CHILDREN_USER.clerkId, CHILDREN_USER);

        const req = new Request('http://localhost:3000/api/arlo/snapshot/camera.aarlo_salon', {
            method: 'POST',
        });
        const res = await POST(req, { params: makeParams('camera.aarlo_salon') });
        expect(res.status).toBe(403);
    });

    it('triggers snapshot switch and returns success for admin', async () => {
        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
        mockHACallService({ entity_id: 'switch.aarlo_snapshot_salon' });

        const req = new Request('http://localhost:3000/api/arlo/snapshot/camera.aarlo_salon', {
            method: 'POST',
        });
        const res = await POST(req, { params: makeParams('camera.aarlo_salon') });
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.entity_id).toBe('camera.aarlo_salon');
    });

    it('returns 502 if HA fails to trigger snapshot switch', async () => {
        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
        mockHAError(500);

        const req = new Request('http://localhost:3000/api/arlo/snapshot/camera.aarlo_jardin', {
            method: 'POST',
        });
        const res = await POST(req, { params: makeParams('camera.aarlo_jardin') });
        expect(res.status).toBe(502);
    });
});

describe('POST /api/arlo/snapshot/[entity_id] — security regressions (S08)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
        resetHAMocks();
        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
    });

    it('rejects a traversal behind the camera.aarlo_ prefix without calling HA', async () => {
        const req = new Request('http://localhost:3000/api/arlo/snapshot/x', { method: 'POST' });
        const res = await POST(req, { params: makeParams('camera.aarlo_x/../../config') });

        expect(res.status).toBe(400);
        expect(mockHaPost).not.toHaveBeenCalled();
    });
});
