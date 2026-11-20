import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '@/app/api/user/me/route';
import { setMockUser, clearMockUsers } from '../setup';
import { mockAsAdmin, mockAsUnauthenticated } from '../helpers/mock-auth';
import { ADMIN_USER } from '../helpers/test-users';

function createRequest() {
    return new Request('http://localhost:3000/api/user/me');
}

const params = Promise.resolve({});

describe('GET /api/user/me', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
    });

    it('returns 401 if unauthenticated', async () => {
        mockAsUnauthenticated();
        const res = await GET(createRequest(), { params });
        expect(res.status).toBe(401);
    });

    it('returns user profile data', async () => {
        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);

        const res = await GET(createRequest(), { params });
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data.email).toBe(ADMIN_USER.email);
        expect(data.group).toBe(ADMIN_USER.group);
        expect(data.permissions).toEqual(ADMIN_USER.userGroup.permissions);
        expect(data.widgetPreferences).toEqual(ADMIN_USER.widgetPreferences);
    });
});
