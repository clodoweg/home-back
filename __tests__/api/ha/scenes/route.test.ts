
import { describe, it, expect, vi } from 'vitest';
import { GET } from '@/app/api/ha/scenes/route';
import { getCachedStates } from '@/lib/ha-states-cache';

vi.mock('@/lib/ha-states-cache', () => ({
    getCachedStates: vi.fn(),
}));

vi.mock('@/lib/api-middleware', () => ({
    withAuth: (fn: any) => fn,
}));

describe('/api/ha/scenes', () => {
    it('returns structured scene brightness data', async () => {
        vi.mocked(getCachedStates).mockResolvedValueOnce({
            ok: true,
            data: [
                {
                    entity_id: 'scene.salon_tv',
                    state: 'on',
                    attributes: { brightness: 100 }
                },
                {
                    entity_id: 'scene.entree_veilleuse',
                    state: 'on',
                    attributes: { brightness: 0 }
                },
                {
                    entity_id: 'light.salon',
                    state: 'on',
                    attributes: { brightness: 255 }
                }
            ],
        });

        const request = {} as any;
        const context = {
            params: Promise.resolve({}),
            user: {} as any,
            userId: 'user_123',
            userEmail: 'test@example.com'
        };

        const response = await GET(request, context);
        const json = await response.json();

        expect(json).toEqual({
            'scene.salon_tv': { brightness: 100 },
            'scene.entree_veilleuse': { brightness: 0 }
        });
        expect(json['light.salon']).toBeUndefined();
    });

    it('returns 502 if HA fetch fails', async () => {
        vi.mocked(getCachedStates).mockResolvedValueOnce({
            ok: false,
            data: [],
        });

        const request = {} as any;
        const context = {
            params: Promise.resolve({}),
            user: {} as any,
            userId: 'user_123',
            userEmail: 'test@example.com'
        };

        const response = await GET(request, context);
        expect(response.status).toBe(502);
    });
});
