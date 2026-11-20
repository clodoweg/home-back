import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '@/app/api/enedis/data/route';
import { setMockUser, clearMockUsers } from '../setup';
import { mockAsAdmin, mockAsChildren } from '../helpers/mock-auth';
import { ADMIN_USER, CHILDREN_USER } from '../helpers/test-users';
import * as enedisService from '@/lib/integrations/enedis';

// Mock the Enedis service explicitly for this test
vi.mock('@/lib/integrations/enedis', () => ({
    getEnedisData: vi.fn(),
}));

const mockGetEnedisData = vi.mocked(enedisService.getEnedisData);

describe('GET /api/enedis/data', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
    });

    it('returns 403 forbidden for users without history permission', async () => {
        mockAsChildren(); // Children have no 'history' permission
        setMockUser(CHILDREN_USER.clerkId, CHILDREN_USER);

        const req = new Request('http://localhost:3000/api/enedis/data?days=7');
        const res = await GET(req, { params: Promise.resolve({}) });

        expect(res.status).toBe(403);
    });

    it('calls getEnedisData and returns data for authorized users', async () => {
        mockAsAdmin(); // Admin has 'history' permission
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);

        const mockData = {
            dailyConsumption: [{ date: '2023-10-01', value: 5000 }],
            dailyMaxPower: [],
            loadCurve: [],
        };
        mockGetEnedisData.mockResolvedValue(mockData as any);

        const req = new Request('http://localhost:3000/api/enedis/data?days=7');
        const res = await GET(req, { params: Promise.resolve({}) });

        expect(res.status).toBe(200);
        const data = await res.json();

        // Assert we called the service and returned the data
        expect(mockGetEnedisData).toHaveBeenCalled();
        expect(data).toEqual(mockData);
    });

    it('returns 500 if service throws', async () => {
        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
        mockGetEnedisData.mockRejectedValue(new Error('DB Error'));

        const req = new Request('http://localhost:3000/api/enedis/data');
        const res = await GET(req, { params: Promise.resolve({}) });

        expect(res.status).toBe(500);
    });
});
