/**
 * Tests for the root proxy.ts (origin check, CORS preflight, Clerk options).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const clerkOptions: { value?: { authorizedParties?: string[] } } = {};
const { clerkHandlerCalls } = vi.hoisted(() => ({ clerkHandlerCalls: { count: 0 } }));

vi.mock('@clerk/nextjs/server', () => ({
    clerkMiddleware: (handler: (auth: unknown, request: NextRequest) => Promise<Response>, options: typeof clerkOptions.value) => {
        clerkOptions.value = options;
        return (request: NextRequest) => {
            clerkHandlerCalls.count += 1;
            return handler(vi.fn(), request);
        };
    },
}));

const { default: middleware, config } = await import('@/proxy');

const call = (method: string, headers: Record<string, string> = {}) =>
    (middleware as unknown as (request: NextRequest) => Promise<Response>)(
        new NextRequest('http://localhost:3000/api/ha/states', { method, headers }),
    );

describe('middleware — origin check in Vercel production', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        clerkHandlerCalls.count = 0;
    });

    const enforceInProduction = () => {
        vi.stubEnv('VERCEL_ENV', 'production');
        vi.stubEnv('CF_ORIGIN_SECRET', 'cf_origin_test_secret');
        vi.stubEnv('ENFORCE_ORIGIN_SECRET', 'true');
    };

    it('refuses a request that bypassed Cloudflare before Clerk and CORS', async () => {
        enforceInProduction();

        const res = await call('GET', { origin: 'https://home.psaltery.org' });

        expect(res.status).toBe(403);
        expect(res.headers.get('access-control-allow-origin')).toBeNull();
        expect(clerkHandlerCalls.count).toBe(0);
    });

    it('refuses a preflight that bypassed Cloudflare too', async () => {
        enforceInProduction();

        expect((await call('OPTIONS', { origin: 'https://home.psaltery.org' })).status).toBe(403);
    });

    it('hands a request carrying the origin secret over to Clerk', async () => {
        enforceInProduction();

        const res = await call('GET', { origin: 'https://home.psaltery.org', 'x-origin-secret': 'cf_origin_test_secret' });

        expect(res.headers.get('x-middleware-next')).toBe('1');
        expect(clerkHandlerCalls.count).toBe(1);
    });

    it('only observes by default: nothing is refused', async () => {
        vi.stubEnv('VERCEL_ENV', 'production');
        vi.stubEnv('CF_ORIGIN_SECRET', 'cf_origin_test_secret');

        const res = await call('GET');

        expect(res.headers.get('x-middleware-next')).toBe('1');
    });
});

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
