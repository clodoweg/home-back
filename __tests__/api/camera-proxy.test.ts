import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET as GET_IMAGE } from '@/app/api/camera_proxy_image/[entity_id]/route';
import { setMockUser, clearMockUsers } from '../setup';
import { mockAsAdmin, mockAsChildren, mockAsUser, mockAsUnauthenticated } from '../helpers/mock-auth';
import { ADMIN_USER, CHILDREN_USER, STANDARD_USER } from '../helpers/test-users';
import { resetHAMocks } from '../helpers/mock-ha';

vi.mock('@/lib/r2', async () => {
    const { NextResponse } = await import('next/server');
    return {
        isR2Configured: vi.fn().mockReturnValue(false),
        isR2Public: vi.fn().mockReturnValue(false),
        uploadToR2: vi.fn().mockResolvedValue(null),
        proxyImageViaR2: vi.fn(async (buffer: Buffer, _key: string, contentType = 'image/jpeg', cacheControl = 'public, max-age=60, stale-while-revalidate=300') => {
            return new NextResponse(new Uint8Array(buffer), {
                status: 200,
                headers: {
                    'Content-Type': contentType,
                    'Content-Length': buffer.length.toString(),
                    'Cache-Control': cacheControl,
                },
            });
        }),
    };
});

const makeParams = (entity_id: string) => Promise.resolve({ entity_id });
const fakeImage = new Uint8Array([0xff, 0xd8, 0xff]);

function mockFetchCameraSuccess(contentType = 'image/jpeg') {
    vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(fakeImage, {
            status: 200,
            headers: { 'content-type': contentType },
        })
    );
}

function mockFetchCameraFailure(status = 503) {
    vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(null, { status, statusText: 'Service Unavailable' })
    );
}

describe('Camera proxy routes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
        resetHAMocks();
    });

    describe('GET /api/camera_proxy_image/[entity_id]', () => {
        it('returns 401 if unauthenticated', async () => {
            mockAsUnauthenticated();
            const req = new Request('http://localhost:3000/api/camera_proxy_image/camera.jardin');
            const res = await GET_IMAGE(req, { params: makeParams('camera.jardin') });
            expect(res.status).toBe(401);
        });

        it('returns 400 for non-camera entity_id', async () => {
            mockAsAdmin();
            setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
            const req = new Request('http://localhost:3000/api/camera_proxy_image/light.salon');
            const res = await GET_IMAGE(req, { params: makeParams('light.salon') });
            expect(res.status).toBe(400);
        });

        it('returns 403 for children (no camera permission)', async () => {
            mockAsChildren();
            setMockUser(CHILDREN_USER.clerkId, CHILDREN_USER);
            const req = new Request('http://localhost:3000/api/camera_proxy_image/camera.jardin');
            const res = await GET_IMAGE(req, { params: makeParams('camera.jardin') });
            expect(res.status).toBe(403);
        });

        it('returns 403 for standard user (no camera permission)', async () => {
            mockAsUser();
            setMockUser(STANDARD_USER.clerkId, STANDARD_USER);
            const req = new Request('http://localhost:3000/api/camera_proxy_image/camera.jardin');
            const res = await GET_IMAGE(req, { params: makeParams('camera.jardin') });
            expect(res.status).toBe(403);
        });

        it('proxies image stream from HA for admin', async () => {
            mockAsAdmin();
            setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
            mockFetchCameraSuccess('image/jpeg');

            const req = new Request('http://localhost:3000/api/camera_proxy_image/camera.jardin');
            const res = await GET_IMAGE(req, { params: makeParams('camera.jardin') });

            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toBe('image/jpeg');
        });

        it.each([401, 403, 503])('returns a generic 502 when HA answers %i (never a fake session error)', async (status) => {
            mockAsAdmin();
            setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
            mockFetchCameraFailure(status);

            const req = new Request('http://localhost:3000/api/camera_proxy_image/camera.jardin');
            const res = await GET_IMAGE(req, { params: makeParams('camera.jardin') });

            expect(res.status).toBe(502);
            expect((await res.json()).error).toBe('Failed to fetch camera image from Home Assistant');
        });

        it('keeps 404 when HA does not know the camera', async () => {
            mockAsAdmin();
            setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
            mockFetchCameraFailure(404);

            const req = new Request('http://localhost:3000/api/camera_proxy_image/camera.inconnue');
            const res = await GET_IMAGE(req, { params: makeParams('camera.inconnue') });

            expect(res.status).toBe(404);
        });

        it('returns 500 on unexpected exception', async () => {
            mockAsAdmin();
            setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
            vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network error'));

            const req = new Request('http://localhost:3000/api/camera_proxy_image/camera.jardin');
            const res = await GET_IMAGE(req, { params: makeParams('camera.jardin') });

            expect(res.status).toBe(500);
        });
    });


});

describe('Camera proxy routes — security regressions (S08)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
    });

    it.each(['camera.x/../../error_log', 'camera.x?y', 'camera.', 'CAMERA.X'])(
        'rejects %s without calling HA',
        async (entityId) => {
            const fetchSpy = vi.spyOn(global, 'fetch');

            const imageRes = await GET_IMAGE(new Request('http://localhost:3000/api/camera_proxy_image/x'), { params: makeParams(entityId) });

            expect(imageRes.status).toBe(400);
            expect(fetchSpy).not.toHaveBeenCalled();
        },
    );
});
