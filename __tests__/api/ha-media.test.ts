import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '@/app/api/ha/media/route';
import { setMockUser, clearMockUsers } from '../setup';
import { mockAsAdmin, mockAsUnauthenticated } from '../helpers/mock-auth';
import { ADMIN_USER } from '../helpers/test-users';
import { resetHAMocks, mockHaPost } from '../helpers/mock-ha';

const params = Promise.resolve({});
const fakeImageBuffer = Buffer.from('fake-media-bytes');

function makeRequest(mediaContentId?: string) {
    const url = mediaContentId
        ? `http://localhost:3000/api/ha/media?media_content_id=${encodeURIComponent(mediaContentId)}`
        : 'http://localhost:3000/api/ha/media';
    return new Request(url);
}

function mockFetchSuccess() {
    vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(fakeImageBuffer, {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
        })
    );
}

function mockFetchFailure() {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
}

describe('GET /api/ha/media', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
        resetHAMocks();

        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
    });

    it('returns 401 if unauthenticated', async () => {
        mockAsUnauthenticated();
        const req = makeRequest('media-source://petkit/100000001/snapshot/img.jpg');
        const res = await GET(req, { params });
        expect(res.status).toBe(401);
    });

    it('returns 400 if media_content_id is missing', async () => {
        const req = makeRequest();
        const res = await GET(req, { params });
        expect(res.status).toBe(400);
    });

    it('proxies petkit media when direct HA fetch succeeds', async () => {
        mockFetchSuccess();

        const req = makeRequest('media-source://petkit/100000001/snapshot/img.jpg');
        const res = await GET(req, { params });

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/jpeg');
        expect(res.headers.get('content-length')).toBe(String(fakeImageBuffer.length));
    });

    it('includes Cache-Control header on successful proxy', async () => {
        mockFetchSuccess();

        const req = makeRequest('media-source://petkit/100000001/img.jpg');
        const res = await GET(req, { params });

        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toContain('max-age=3600');
    });

    it('attempts browse_media fallback when all direct HA paths fail', async () => {
        // All direct fetches fail
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));

        // browse_media fallback returns a thumbnail URL
        mockHaPost.mockResolvedValue({
            ok: true,
            status: 200,
            duration: 10,
            data: {
                service_response: {
                    'media_player.tv': { thumbnail: '/local/fallback.jpg' }
                }
            },
        });

        // Second fetch for the resolved fallback URL succeeds
        vi.spyOn(global, 'fetch')
            .mockResolvedValueOnce(new Response(null, { status: 404 }))  // direct path 1
            .mockResolvedValueOnce(new Response(null, { status: 404 }))  // direct path 2
            .mockResolvedValueOnce(                                       // fallback fetch
                new Response(fakeImageBuffer, {
                    status: 200,
                    headers: { 'content-type': 'image/jpeg' },
                })
            );

        const req = makeRequest('media-source://petkit/100000001/fallback.jpg');
        const res = await GET(req, { params });

        expect(res.status).toBe(200);
        expect(mockHaPost).toHaveBeenCalledWith(
            expect.stringContaining('browse_media'),
            expect.any(Object),
            'ha-media-resolve-fallback'
        );
    });

    it('returns 502 when all HA paths and fallback fail', async () => {
        mockFetchFailure();
        mockHaPost.mockResolvedValue({ ok: false, status: 500, duration: 10, data: null });

        const req = makeRequest('media-source://petkit/100000001/missing.jpg');
        const res = await GET(req, { params });

        expect(res.status).toBe(502);
    });
});

describe('GET /api/ha/media — security regressions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
        resetHAMocks();
        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
    });

    it.each([
        'media-source://local/../../error_log',
        'media-source://local/media/../../config.jpg',
        'media-source://media_source/local/../../config.jpg',
        '../../error_log',
        'https://evil.example/a.jpg',
    ])('rejects %s without calling HA (S02)', async (mediaContentId) => {
        const fetchSpy = vi.spyOn(global, 'fetch');

        const res = await GET(makeRequest(mediaContentId), { params });

        expect(res.status).toBe(400);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(mockHaPost).not.toHaveBeenCalled();
    });

    it('never sends the HA token to a host returned by browse_media (S07)', async () => {
        const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
        mockHaPost.mockResolvedValue({
            ok: true,
            status: 200,
            duration: 10,
            data: { service_response: { 'media_player.tv': { thumbnail: 'https://attacker.example/steal.jpg' } } },
        });

        const res = await GET(makeRequest('media-source://petkit/100000001/a.jpg'), { params });

        expect(res.status).toBe(502);
        const calledUrls = fetchSpy.mock.calls.map(([url]) => String(url));
        expect(calledUrls.every(url => url.startsWith('http://ha-mock.local:8123/'))).toBe(true);
    });

    it('serves media as private content', async () => {
        mockFetchSuccess();

        const res = await GET(makeRequest('media-source://local/media/1/20260101/feed/snapshot/1_0815.jpg'), { params });

        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('private, max-age=3600');
    });
});
