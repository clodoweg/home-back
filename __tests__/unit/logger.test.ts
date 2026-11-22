import { describe, it, expect, vi, afterEach } from 'vitest';

/** The logger is mocked globally in setup.ts: load the real module. */
async function loadLogger(env: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    vi.resetModules();
    return (await vi.importActual<typeof import('@/lib/logger')>('@/lib/logger')).logger;
}

describe('logger', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('writes one JSON line per entry in production, on the matching console method', async () => {
        const logger = await loadLogger({ NODE_ENV: 'production', LOG_FORMAT: 'json' });
        const spies = {
            debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
            info: vi.spyOn(console, 'info').mockImplementation(() => {}),
            warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
            error: vi.spyOn(console, 'error').mockImplementation(() => {}),
        };

        logger.debug('d');
        logger.info('i', { requestId: 'r1' });
        logger.warn('w');
        logger.error('e');

        for (const spy of Object.values(spies)) expect(spy).toHaveBeenCalledTimes(1);
        const entry = JSON.parse(spies.info.mock.calls[0][0] as string);
        expect(entry).toMatchObject({ level: 'info', message: 'i', service: 'home-back', context: { requestId: 'r1' } });
    });

    it('tags the specialised events', async () => {
        const logger = await loadLogger({ NODE_ENV: 'production', LOG_FORMAT: 'json' });
        const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const eventsOf = (spy: typeof info) => spy.mock.calls.map(([line]) => JSON.parse(line as string).context.event);

        logger.apiRequest({ path: '/a' });
        logger.apiResponse({ status: 200 });
        logger.apiResponse({ status: 503 });
        logger.security('denied', { ip: '1.2.3.4' });
        logger.rateLimit({ ip: '1.2.3.4' });
        logger.haCall({ haPath: '/api/states' });

        // Routine traces are debug (P12); completion is info, problems are warn
        expect(eventsOf(debug)).toEqual(['api.request.start', 'ha.api.call']);
        expect(eventsOf(info)).toEqual(['api.request.complete']);
        expect(eventsOf(warn).sort((a, b) => a.localeCompare(b))).toEqual(['api.request.complete', 'rate_limit', 'security']);
    });

    it('uses a human-readable line in development', async () => {
        const logger = await loadLogger({ NODE_ENV: 'development' });
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});

        logger.info('hello', { path: '/x', skipped: undefined });

        const line = info.mock.calls[0][0] as string;
        expect(line).toContain('hello path=/x');
        expect(line).not.toContain('skipped');
    });
});
