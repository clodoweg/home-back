/**
 * Unit tests for lib/haClient.ts
 * Uses the real implementation (unmocked) with a mocked global fetch.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Unmock haClient so we test the real implementation
vi.unmock('@/lib/haClient');

import { HA_TIMEOUT_MS, haFetch, haFetchBinary, haGet, haPost } from '@/lib/haClient';
import { runWithRequestId } from '@/lib/request-context';

describe('haClient', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.HA_BASE_URL = 'http://ha-mock.local:8123';
        process.env.HA_ACCESS_TOKEN = 'test-ha-token';
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('haFetch', () => {
        it('throws if HA_BASE_URL is missing', async () => {
            delete process.env.HA_BASE_URL;
            await expect(haFetch('/api/states')).rejects.toThrow('Missing HA_BASE_URL or HA_ACCESS_TOKEN');
        });

        it('throws if HA_ACCESS_TOKEN is missing', async () => {
            delete process.env.HA_ACCESS_TOKEN;
            await expect(haFetch('/api/states')).rejects.toThrow('Missing HA_BASE_URL or HA_ACCESS_TOKEN');
        });

        it('sends GET request with Bearer token and correct URL', async () => {
            const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
                new Response(JSON.stringify({ entity_id: 'light.salon' }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                })
            );

            await haFetch('/api/states/light.salon', { label: 'test' });

            expect(fetchSpy).toHaveBeenCalledWith(
                'http://ha-mock.local:8123/api/states/light.salon',
                expect.objectContaining({
                    method: 'GET',
                    headers: expect.objectContaining({
                        'Authorization': 'Bearer test-ha-token',
                    }),
                    cache: 'no-store',
                })
            );
        });

        it('returns { ok: true, data, status, duration } on success', async () => {
            const payload = [{ entity_id: 'light.salon', state: 'on' }];
            vi.spyOn(global, 'fetch').mockResolvedValue(
                new Response(JSON.stringify(payload), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                })
            );

            const result = await haFetch('/api/states');

            expect(result.ok).toBe(true);
            expect(result.status).toBe(200);
            expect(result.data).toEqual(payload);
            expect(typeof result.duration).toBe('number');
        });

        it('returns { ok: false, status, data: null } on non-2xx response (no retry for errors)', async () => {
            vi.spyOn(global, 'fetch')
                .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
                .mockResolvedValueOnce(new Response('Not Found', { status: 404 })); // retry

            const result = await haFetch('/api/states/nonexistent', {}, true); // _retried=true to skip retry

            expect(result.ok).toBe(false);
            expect(result.status).toBe(404);
            expect(result.data).toBeNull();
        });

        it('parses plain text response when content-type is not JSON', async () => {
            vi.spyOn(global, 'fetch').mockResolvedValue(
                new Response('on', {
                    status: 200,
                    headers: { 'content-type': 'text/plain' },
                })
            );

            const result = await haFetch<string>('/api/template');

            expect(result.ok).toBe(true);
            expect(result.data).toBe('on');
        });

        it('does not retry an invalid JSON body', async () => {
            const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () =>
                new Response('{broken', { headers: { 'content-type': 'application/json' } }));

            await expect(haFetch('/api/states')).rejects.toThrow(SyntaxError);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });

        it('retries GET once on network error', async () => {
            const fetchSpy = vi.spyOn(global, 'fetch')
                // undici reports a refused connection as TypeError('fetch failed')
                .mockRejectedValueOnce(new TypeError('fetch failed'))
                .mockResolvedValueOnce(
                    new Response(JSON.stringify({ ok: true }), {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    })
                );

            const result = await haFetch('/api/states', { method: 'GET' });

            expect(fetchSpy).toHaveBeenCalledTimes(2);
            expect(result.ok).toBe(true);
        });

        it('does NOT retry POST requests on network error', async () => {
            const fetchSpy = vi.spyOn(global, 'fetch')
                .mockRejectedValue(new Error('ECONNREFUSED'));

            await expect(
                haFetch('/api/services/light/turn_on', { method: 'POST', body: {} })
            ).rejects.toThrow('ECONNREFUSED');

            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });

        it('throws after retry also fails', async () => {
            vi.spyOn(global, 'fetch')
                .mockRejectedValueOnce(new Error('timeout'))
                .mockRejectedValueOnce(new Error('timeout again'));

            await expect(haFetch('/api/states')).rejects.toThrow();
        });

        it('accepts a full URL on the HA origin', async () => {
            const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
                new Response(JSON.stringify({}), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                })
            );

            await haFetch('http://ha-mock.local:8123/media/local/a.jpg', {}, true);

            expect(fetchSpy).toHaveBeenCalledWith('http://ha-mock.local:8123/media/local/a.jpg', expect.any(Object));
        });

        it('never sends the HA token to another host', async () => {
            const fetchSpy = vi.spyOn(global, 'fetch');

            await expect(haFetch('http://other-host.local/api/states', {}, true)).rejects.toThrow('outside the HA origin');
            await expect(haFetchBinary('https://evil.example/a.jpg')).rejects.toThrow('outside the HA origin');
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it('does not retry a timed-out call (P02: at most one HA timeout per request)', async () => {
            const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
            const fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(timeout);

            await expect(haFetch('/api/states')).rejects.toThrow('timeout');
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });

        it('arms a 10-second timeout signal on every call', async () => {
            const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { headers: { 'content-type': 'application/json' } }));
            const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

            await haFetch('/api/states');

            expect(timeoutSpy).toHaveBeenCalledWith(HA_TIMEOUT_MS);
            expect(HA_TIMEOUT_MS).toBe(10_000);
            expect(fetchSpy.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
        });

        it('forwards the id of the request being processed to HA (P12)', async () => {
            const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));

            await runWithRequestId('front-42', () => haFetch('/api/states'));
            await haFetch('/api/states');

            expect(fetchSpy.mock.calls[0][1]?.headers).toMatchObject({ 'X-Request-Id': 'front-42' });
            expect(fetchSpy.mock.calls[1][1]?.headers).toMatchObject({ 'X-Request-Id': 'no-id' });
        });
    });

    describe('haGet', () => {
        it('delegates to haFetch with GET method', async () => {
            vi.spyOn(global, 'fetch').mockResolvedValue(
                new Response(JSON.stringify([]), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                })
            );

            const result = await haGet('/api/states', 'states');
            expect(result.ok).toBe(true);
        });
    });

    describe('haPost', () => {
        it('delegates to haFetch with POST method and serializes body', async () => {
            const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
                new Response(JSON.stringify([]), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                })
            );

            await haPost('/api/services/light/turn_on', { entity_id: 'light.salon' }, 'test');

            expect(fetchSpy).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    method: 'POST',
                    body: JSON.stringify({ entity_id: 'light.salon' }),
                })
            );
        });
    });

    describe('haFetchBinary', () => {
        it('returns the bytes and content type of an HA image', async () => {
            const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
                new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
            );

            const image = await haFetchBinary('/api/camera_proxy/camera.x', { label: 'camera' });

            expect(image).toEqual({ ok: true, status: 200, contentType: 'image/png', bytes: new Uint8Array([1, 2, 3]) });
            expect(fetchSpy.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer test-ha-token' });
        });

        it('reports HA errors without reading a body', async () => {
            vi.spyOn(global, 'fetch').mockResolvedValue(new Response('nope', { status: 404 }));

            expect(await haFetchBinary('/api/camera_proxy/camera.x')).toMatchObject({ ok: false, status: 404, bytes: null });
        });

        it('aborts when the caller cancels the probe', async () => {
            vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
                if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
                return new Response(new Uint8Array([1]));
            });
            const controller = new AbortController();
            controller.abort();

            await expect(haFetchBinary('/media/local/a.jpg', { signal: controller.signal })).rejects.toThrow('aborted');
        });
    });
});
