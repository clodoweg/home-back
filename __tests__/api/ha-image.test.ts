import { describe, it, expect, beforeEach, vi } from 'vitest';
import { verifyToken } from '@clerk/nextjs/server';
import { GET } from '@/app/api/ha/image/[entity_id]/route';
import { setMockUser, clearMockUsers } from '../setup';
import { mockAsAdmin, mockAsUnauthenticated } from '../helpers/mock-auth';
import { ADMIN_USER } from '../helpers/test-users';
import { resetHAMocks } from '../helpers/mock-ha';

const makeParams = (entity_id: string) => Promise.resolve({ entity_id });

const fakeImageBuffer = Buffer.from('fake-jpeg-bytes');

function mockFetchSuccess(contentType = 'image/jpeg') {
    vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(fakeImageBuffer, {
            status: 200,
            headers: { 'content-type': contentType },
        })
    );
}

function mockFetchFailure(status = 404) {
    vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(null, { status })
    );
}

describe('GET /api/ha/image/[entity_id]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
        resetHAMocks();

        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
    });

    it('returns 401 if unauthenticated', async () => {
        mockAsUnauthenticated();
        mockFetchSuccess();
        const req = new Request('http://localhost:3000/api/ha/image/image.croquettes_dernier_repas');
        const res = await GET(req, { params: makeParams('image.croquettes_dernier_repas') });
        expect(res.status).toBe(401);
    });

    it('proxies image bytes from HA with correct content-type', async () => {
        mockFetchSuccess('image/jpeg');

        const req = new Request('http://localhost:3000/api/ha/image/image.croquettes_dernier_repas');
        const res = await GET(req, { params: makeParams('image.croquettes_dernier_repas') });

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/jpeg');
        expect(res.headers.get('content-length')).toBe(String(fakeImageBuffer.length));
    });

    it('includes Cache-Control header on success', async () => {
        mockFetchSuccess();

        const req = new Request('http://localhost:3000/api/ha/image/image.croquettes_dish_before');
        const res = await GET(req, { params: makeParams('image.croquettes_dish_before') });

        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toContain('max-age=3600');
    });

    it('keeps 404 when HA has no such image', async () => {
        mockFetchFailure(404);

        const req = new Request('http://localhost:3000/api/ha/image/image.inconnue');
        const res = await GET(req, { params: makeParams('image.inconnue') });

        expect(res.status).toBe(404);
    });

    it.each([401, 403, 500, 503])('returns a generic 502 when HA answers %i (never a fake session error)', async (status) => {
        mockFetchFailure(status);

        const req = new Request('http://localhost:3000/api/ha/image/image.croquettes_dernier_repas');
        const res = await GET(req, { params: makeParams('image.croquettes_dernier_repas') });

        expect(res.status).toBe(502);
        expect((await res.json()).error).toBe('Failed to fetch image from Home Assistant');
    });

    it('returns 500 when HA throws an exception', async () => {
        vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network error'));

        const req = new Request('http://localhost:3000/api/ha/image/image.croquettes_dernier_repas');
        const res = await GET(req, { params: makeParams('image.croquettes_dernier_repas') });

        expect(res.status).toBe(500);
    });
});

describe('GET /api/ha/image/[entity_id] — security regressions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
    });

    it.each(['camera.aarlo_salon', '../camera_proxy/camera.aarlo_salon', 'image.x/../../config', 'IMAGE.X'])(
        'rejects entity_id %s without calling HA (S03)',
        async (entityId) => {
            const fetchSpy = vi.spyOn(global, 'fetch');
            const res = await GET(new Request('http://localhost:3000/api/ha/image/x'), { params: makeParams(entityId) });

            expect(res.status).toBe(400);
            expect(fetchSpy).not.toHaveBeenCalled();
        },
    );

    it('serves the image as private content with an image content type', async () => {
        mockFetchSuccess('text/html');
        const res = await GET(new Request('http://localhost:3000/api/ha/image/x'), {
            params: makeParams('image.croquettes_dernier_repas'),
        });

        expect(res.headers.get('cache-control')).toBe('private, max-age=3600');
        expect(res.headers.get('content-type')).toBe('image/jpeg');
    });

    it('rejects a token passed in the query string (S10)', async () => {
        mockAsUnauthenticated();
        // Even a token Clerk would accept must be ignored when it comes from the URL
        vi.mocked(verifyToken).mockResolvedValue({ sub: ADMIN_USER.clerkId } as any);
        const res = await GET(new Request('http://localhost:3000/api/ha/image/x?token=valid.jwt.token'), {
            params: makeParams('image.croquettes_dernier_repas'),
        });

        expect(res.status).toBe(401);
    });
});
