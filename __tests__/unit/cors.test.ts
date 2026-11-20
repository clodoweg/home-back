import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextResponse } from 'next/server';
import { applyCorsHeaders, buildCorsHeaders } from '@/lib/cors';

describe('buildCorsHeaders', () => {
    it('echoes an allowed origin with restricted methods and headers', () => {
        const headers = buildCorsHeaders('https://home.psaltery.org');
        expect(headers).toEqual({
            'Access-Control-Allow-Origin': 'https://home.psaltery.org',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Request-Id',
            'Access-Control-Max-Age': '86400',
            Vary: 'Origin',
        });
    });

    it.each(['', 'https://evil.example', 'http://localhost:8081', 'http://192.168.1.157:3000', 'https://home.psaltery.org.evil.example'])(
        'sends no CORS header for origin "%s" (never a wildcard)',
        (origin) => {
            expect(buildCorsHeaders(origin)).toEqual({});
        },
    );

    it('applies headers on a response', () => {
        const res = applyCorsHeaders(NextResponse.json({}), buildCorsHeaders('https://home.psaltery.org'));
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://home.psaltery.org');
    });
});

describe('ALLOWED_ORIGINS in production', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    it('keeps only the front and the local Vite dev server', async () => {
        vi.stubEnv('NODE_ENV', 'production');
        vi.resetModules();
        const { ALLOWED_ORIGINS, AUTHORIZED_PARTIES } = await import('@/lib/cors');

        expect([...ALLOWED_ORIGINS]).toEqual(['https://home.psaltery.org', 'http://localhost:5173']);
        expect(AUTHORIZED_PARTIES).toEqual(['https://home.psaltery.org', 'http://localhost:5173']);
    });

    it('adds the 127.0.0.1 variant outside production', async () => {
        vi.resetModules();
        const { ALLOWED_ORIGINS } = await import('@/lib/cors');

        expect(ALLOWED_ORIGINS.has('http://127.0.0.1:5173')).toBe(true);
    });
});
