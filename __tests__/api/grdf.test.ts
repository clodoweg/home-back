import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '@/app/api/grdf/route';
import { setMockUser, clearMockUsers } from '../setup';
import { mockAsAdmin } from '../helpers/mock-auth';
import { ADMIN_USER } from '../helpers/test-users';
import * as grdfService from '@/lib/integrations/grdf';

vi.mock('@/lib/integrations/grdf', () => ({
    getGrdfData: vi.fn(),
}));

const mockGetGrdfData = vi.mocked(grdfService.getGrdfData);

describe('GET /api/grdf', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
    });

    it('fetches GRDF data and formats it correctly', async () => {
        const mockDbData = [
            {
                date: new Date('2023-10-01T00:00:00Z'),
                value: 45,
                energy: 500,
                temp: 12.5,
                isEstimate: false,
            },
            {
                date: new Date('2023-10-02T00:00:00Z'),
                value: 40,
                energy: 440,
                temp: 14.1,
                isEstimate: true, // Estimate should be propagated
            }
        ];

        mockGetGrdfData.mockResolvedValue(mockDbData as any);

        const req = new Request('http://localhost:3000/api/grdf?days=2');
        const res = await GET(req, { params: Promise.resolve({}) });

        expect(res.status).toBe(200);
        const data = await res.json();

        expect(data.dailyConsumption).toHaveLength(2);
        expect(data.dailyConsumption[0].date).toBe('2023-10-01T00:00:00.000Z');
        expect(data.dailyConsumption[0].value).toBe(45);
        expect(data.dailyConsumption[1].isEstimate).toBe(true);
    });

    it('returns 500 on service error', async () => {
        mockGetGrdfData.mockRejectedValue(new Error('Connection Refused'));

        const req = new Request('http://localhost:3000/api/grdf');
        const res = await GET(req, { params: Promise.resolve({}) });

        expect(res.status).toBe(500);
    });
});

describe('GET /api/grdf — error leaks (S11)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
    });

    it('returns a generic 500 without the internal error message', async () => {
        mockGetGrdfData.mockRejectedValue(new Error('PrismaClientKnownRequestError: relation "users" at db.internal:5432'));

        const res = await GET(new Request('http://localhost:3000/api/grdf'), { params: Promise.resolve({}) });

        expect(res.status).toBe(500);
        const body = JSON.stringify(await res.json());
        expect(body).not.toContain('Prisma');
        expect(body).not.toContain('db.internal');
    });
});
