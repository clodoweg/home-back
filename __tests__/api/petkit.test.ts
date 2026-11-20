import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '@/app/api/petkit/route';
import { setMockUser, clearMockUsers } from '../setup';
import { mockAsAdmin, mockAsChildren } from '../helpers/mock-auth';
import { ADMIN_USER, CHILDREN_USER } from '../helpers/test-users';
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

describe('GET /api/petkit', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
    });

    it('returns data structure with devices and records from HA', async () => {
        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);

        // Mock HA states
        mockHaGet.mockResolvedValue({
            ok: true,
            data: [
                {
                    entity_id: 'sensor.croquettes_quantite_distribuee',
                    state: '50',
                },
                {
                    entity_id: 'sensor.croquettes_niveau_de_l_absorbeur_d_humidite',
                    state: '90',
                },
                {
                    entity_id: 'binary_sensor.croquettes_alimentation_basse',
                    state: 'off',
                },
                {
                    entity_id: 'sensor.croquettes_batterie',
                    state: '100',
                },
                {
                    entity_id: 'binary_sensor.croquettes_sur_batterie',
                    state: 'off',
                }
            ],
            duration: 10,
            status: 200
        });

        const req = new Request('http://localhost:3000/api/petkit');
        const res = await GET(req, { params: Promise.resolve({}) });

        expect(res.status).toBe(200);
        const json = await res.json();

        expect(json.devices).toHaveLength(1);
        expect(json.devices[0].name).toBe('Croquettes');
        expect(json.devices[0].status.pim).toBe(90);
    });

    it('limits children (no history) and scrubs images', async () => {
        mockAsChildren();
        setMockUser(CHILDREN_USER.clerkId, CHILDREN_USER);

        mockHaGet.mockResolvedValue({
            ok: true,
            data: [
                {
                    entity_id: 'image.croquettes_dernier_repas',
                    state: new Date().toISOString(),
                    attributes: {
                        entity_picture: '/api/image_proxy?entity_id=image.croquettes_dernier_repas'
                    }
                }
            ],
            duration: 10,
            status: 200
        });

        const req = new Request('http://localhost:3000/api/petkit?days=7');
        const res = await GET(req, { params: Promise.resolve({}) });
        const json = await res.json();

        // Children asked for history, but records should have preview scrubbed
        expect(json.records.length).toBeGreaterThan(0);
        expect(json.records[0].preview).toBeUndefined(); // Scrubbed!
    });
});
