import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST } from '@/app/api/petkit/feed/route';
import { haPost } from '@/lib/haClient';
import { setMockUser, clearMockUsers } from '../setup';
import { mockAsAdmin, mockAsUser } from '../helpers/mock-auth';
import { ADMIN_USER, STANDARD_USER } from '../helpers/test-users';

// Mock haClient
vi.mock('@/lib/haClient', () => ({
    haGet: vi.fn(),
    haPost: vi.fn(),
}));

const mockHaPost = vi.mocked(haPost);

describe('POST /api/petkit/feed', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
    });

    it('triggers manual feed by setting amounts and pressing button', async () => {
        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);

        mockHaPost.mockResolvedValue({
            ok: true,
            data: { success: true },
            duration: 10,
            status: 200
        });

        const req = new Request('http://localhost:3000/api/petkit/feed', {
            method: 'POST',
            body: JSON.stringify({
                deviceId: 1,
                amount1: 1,
                amount2: 1
            })
        });

        const res = await POST(req, { params: Promise.resolve({}) });

        expect(res.status).toBe(200);
        
        // Should have called HA 3 times
        expect(mockHaPost).toHaveBeenCalledTimes(3);
        
        // 1. Reservoir 1
        expect(mockHaPost).toHaveBeenCalledWith('/api/services/text/set_value', {
            entity_id: 'text.croquettes_distribution_manuelle_reservoir_1',
            value: '1'
        }, 'petkit-feeder-amount-1');
        
        // 2. Reservoir 2
        expect(mockHaPost).toHaveBeenCalledWith('/api/services/text/set_value', {
            entity_id: 'text.croquettes_distribution_manuelle_reservoir_2',
            value: '1'
        }, 'petkit-feeder-amount-2');
        
        // 3. Press button
        expect(mockHaPost).toHaveBeenCalledWith('/api/services/button/press', {
            entity_id: 'button.croquettes_distribution_manuelle'
        }, 'petkit-feeder-manual');
    });

    it('returns 400 if deviceId is missing', async () => {
        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);

        const req = new Request('http://localhost:3000/api/petkit/feed', {
            method: 'POST',
            body: JSON.stringify({
                amount1: 1
            })
        });

        const res = await POST(req, { params: Promise.resolve({}) });
        expect(res.status).toBe(400);
    });

    it('refuses to feed for a non-admin group (only the owner acts on the house)', async () => {
        mockAsUser();
        setMockUser(STANDARD_USER.clerkId, STANDARD_USER);

        const req = new Request('http://localhost:3000/api/petkit/feed', {
            method: 'POST',
            body: JSON.stringify({ deviceId: 1, amount1: 1 }),
        });

        const res = await POST(req, { params: Promise.resolve({}) });
        expect(res.status).toBe(403);
        expect(mockHaPost).not.toHaveBeenCalled();
    });
});
