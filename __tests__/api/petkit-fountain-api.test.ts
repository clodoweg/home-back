import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '@/app/api/petkit/route';
import { setMockUser, clearMockUsers } from '../setup';
import { mockAsAdmin } from '../helpers/mock-auth';
import { ADMIN_USER } from '../helpers/test-users';
import { haGet } from '@/lib/haClient';

// Mock haClient
vi.mock('@/lib/haClient', () => ({
    haGet: vi.fn(),
    haPost: vi.fn(),
}));

// The route reads the states through the shared cache: route it to the same haGet mock
vi.mock('@/lib/ha-states-cache', () => ({
    getCachedStates: async () => {
        const { data, ok } = await haGet('/api/states');
        return { data: data ?? [], ok };
    },
}));

const mockHaGet = vi.mocked(haGet);

describe('GET /api/petkit (Fountain Data)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
    });

    it('returns fountain devices and data from HA', async () => {
        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);

        // Mock HA states for fountain
        mockHaGet.mockResolvedValue({
            ok: true,
            data: [
                {
                    entity_id: 'sensor.fontaine_etat_du_filtre',
                    state: '85',
                },
                {
                    entity_id: 'binary_sensor.fontaine_manque_d_eau',
                    state: 'off',
                },
                {
                    entity_id: 'switch.fontaine_pompe',
                    state: 'on',
                },
                {
                    entity_id: 'switch.fontaine_anneau_lumineux',
                    state: 'on',
                }
            ],
            duration: 10,
            status: 200
        });

        const req = new Request('http://localhost:3000/api/petkit?days=1');
        const res = await GET(req, { params: Promise.resolve({}) });

        expect(res.status).toBe(200);
        const json = await res.json();

        // Verify device mapping
        expect(json.devices).toHaveLength(1);
        expect(json.devices[0].name).toBe('Fontaine');
        expect(json.devices[0].deviceType).toBe('Ctw3');
        expect(json.devices[0].status.runStatus).toBe(1);
    });
});
