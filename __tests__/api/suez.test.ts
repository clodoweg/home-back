/**
 * Suez Water API Route Tests
 * Covers GET /api/suez endpoint mapping, validation, and error fallback.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '@/app/api/suez/route';
import { setMockUser, clearMockUsers } from '../setup';
import { mockAsAdmin } from '../helpers/mock-auth';
import { ADMIN_USER } from '../helpers/test-users';
import * as suezService from '@/lib/integrations/suez';

vi.mock('@/lib/integrations/suez', () => ({
    getSuezData: vi.fn(),
}));

const mockGetSuezData = vi.mocked(suezService.getSuezData);

describe('GET /api/suez', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
    });

    it('fetches Suez data and formats it correctly', async () => {
        const mockSuezPayload = {
            dailyConsumption: [
                {
                    date: new Date('2026-05-30T00:00:00.000Z'),
                    value: 120,
                },
                {
                    date: new Date('2026-05-31T00:00:00.000Z'),
                    value: 155,
                }
            ],
            price: 2.74
        };

        mockGetSuezData.mockResolvedValue(mockSuezPayload as any);

        const req = new Request('http://localhost:3000/api/suez');
        const res = await GET(req, { params: Promise.resolve({}) });

        expect(res.status).toBe(200);
        const data = await res.json();

        expect(data.dailyConsumption).toHaveLength(2);
        expect(data.dailyConsumption[0].date).toBe('2026-05-30T00:00:00.000Z');
        expect(data.dailyConsumption[0].value).toBe(120);
        expect(data.dailyConsumption[1].date).toBe('2026-05-31T00:00:00.000Z');
        expect(data.dailyConsumption[1].value).toBe(155);
        expect(data.price).toBe(2.74);
    });

    it('returns 500 on service error', async () => {
        mockGetSuezData.mockRejectedValue(new Error('Connection Refused'));

        const req = new Request('http://localhost:3000/api/suez');
        const res = await GET(req, { params: Promise.resolve({}) });

        expect(res.status).toBe(500);
    });
});
