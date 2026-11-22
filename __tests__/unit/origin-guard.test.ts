/** Tests of lib/origin-guard.ts: observe, then enforce, the origin secret injected by Cloudflare */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { guardOrigin, resetOriginGuardReport } from '@/lib/origin-guard';
import { logger } from '@/lib/logger';

const ORIGIN_SECRET = 'cf_origin_test_secret';

const request = (headers: Record<string, string> = {}) =>
    new Request('https://home-back.example/api/ha/states', { headers });

describe('guardOrigin', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetOriginGuardReport();
        vi.stubEnv('VERCEL_ENV', 'production');
        vi.stubEnv('CF_ORIGIN_SECRET', ORIGIN_SECRET);
        vi.stubEnv('ENFORCE_ORIGIN_SECRET', '');
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    describe('observe mode (default)', () => {
        it('lets a request through Cloudflare pass and logs it as ok', () => {
            expect(guardOrigin(request({ 'x-origin-secret': ORIGIN_SECRET }))).toBeNull();
            expect(logger.debug).toHaveBeenCalledWith('Origin check ok', { path: '/api/ha/states', enforced: false, event: 'origin_check' });
        });

        it('lets a request without the secret pass, but logs it', () => {
            expect(guardOrigin(request())).toBeNull();
            expect(logger.warn).toHaveBeenCalledWith('Origin check missing', expect.objectContaining({ enforced: false }));
        });

        it('lets a request with a wrong secret pass, but logs it', () => {
            expect(guardOrigin(request({ 'x-origin-secret': 'guess' }))).toBeNull();
            expect(logger.warn).toHaveBeenCalledWith('Origin check mismatch', expect.objectContaining({ path: '/api/ha/states' }));
        });
    });

    describe('enforce mode (ENFORCE_ORIGIN_SECRET=true)', () => {
        beforeEach(() => {
            vi.stubEnv('ENFORCE_ORIGIN_SECRET', 'true');
        });

        it('lets a request through Cloudflare pass without logging it', () => {
            expect(guardOrigin(request({ 'x-origin-secret': ORIGIN_SECRET }))).toBeNull();
            expect(logger.debug).not.toHaveBeenCalled();
        });

        it.each([
            ['missing', {}],
            ['mismatch', { 'x-origin-secret': 'guess' }],
        ])('refuses a request whose secret is %s with a generic 403', async (status, headers) => {
            const response = guardOrigin(request(headers));

            expect(response?.status).toBe(403);
            const body = await response?.json();
            expect(body).toMatchObject({ error: 'Forbidden', code: 'ORIGIN_FORBIDDEN' });
            expect(JSON.stringify(body)).not.toContain(ORIGIN_SECRET);
            expect(logger.warn).toHaveBeenCalledWith(`Origin check ${status}`, expect.objectContaining({ enforced: true }));
        });
    });

    it('fails open, and reports it once, when CF_ORIGIN_SECRET is not set', () => {
        vi.stubEnv('CF_ORIGIN_SECRET', '');
        vi.stubEnv('ENFORCE_ORIGIN_SECRET', 'true');

        expect(guardOrigin(request())).toBeNull();
        expect(guardOrigin(request())).toBeNull();
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith('Origin check skipped: CF_ORIGIN_SECRET is not set');
    });

    it.each(['preview', 'development', ''])('checks nothing outside Vercel production (VERCEL_ENV="%s")', (vercelEnv) => {
        vi.stubEnv('VERCEL_ENV', vercelEnv);
        vi.stubEnv('ENFORCE_ORIGIN_SECRET', 'true');

        expect(guardOrigin(request())).toBeNull();
        expect(logger.warn).not.toHaveBeenCalled();
    });
});
