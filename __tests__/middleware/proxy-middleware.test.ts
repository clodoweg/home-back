/**
 * Tests for the root proxy.ts (CORS preflight, Clerk options).
 */
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

const clerkOptions: { value?: { authorizedParties?: string[] } } = {};

vi.mock('@clerk/nextjs/server', () => ({
    clerkMiddleware: (handler: (auth: unknown, request: NextRequest) => Promise<Response>, options: typeof clerkOptions.value) => {
        clerkOptions.value = options;
        return (request: NextRequest) => handler(vi.fn(), request);
    },
}));

const { default: middleware, config } = await import('@/proxy');

const call = (method: string, headers: Record<string, string> = {}) =>
    (middleware as unknown as (request: NextRequest) => Promise<Response>)(
        new NextRequest('http://localhost:3000/api/ha/states', { method, headers }),
    );

describe('middleware', () => {
    it('answers an allowed preflight with the CORS headers', async () => {
        const res = await call('OPTIONS', { origin: 'https://home.psaltery.org' });

        expect(res.status).toBe(204);
        expect(res.headers.get('access-control-allow-origin')).toBe('https://home.psaltery.org');
        expect(res.headers.get('access-control-allow-headers')).toContain('Authorization');
    });

    it('answers a preflight from an unknown origin without any CORS header', async () => {
        const res = await call('OPTIONS', { origin: 'https://evil.example' });

        expect(res.status).toBe(204);
        expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('lets normal requests through with CORS headers for allowed origins only', async () => {
        const allowed = await call('GET', { origin: 'https://home.psaltery.org' });
        const refused = await call('GET', { origin: 'https://evil.example' });

        expect(allowed.headers.get('x-middleware-next')).toBe('1');
        expect(allowed.headers.get('access-control-allow-origin')).toBe('https://home.psaltery.org');
        expect(refused.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('adds no CORS header to server-to-server calls without Origin', async () => {
        const res = await call('GET');

        expect(res.headers.get('x-middleware-next')).toBe('1');
        expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('restricts Clerk tokens to the known front origins (S13)', () => {
        expect(clerkOptions.value?.authorizedParties).toContain('https://home.psaltery.org');
        expect(clerkOptions.value?.authorizedParties).not.toContain('http://localhost:8081');
    });

    it('runs on API routes', () => {
        expect(config.matcher).toContain('/(api|trpc)(.*)');
    });
});
