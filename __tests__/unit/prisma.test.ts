import { describe, it, expect, vi, afterEach } from 'vitest';
import { logger } from '@/lib/logger';

let capturedExtension: { query: { $allOperations: (args: Record<string, unknown>) => Promise<unknown> } } | null = null;

const adapterOptions: Array<Record<string, unknown>> = [];

vi.mock('@prisma/adapter-pg', () => ({
    PrismaPg: vi.fn(function PrismaPg(options: Record<string, unknown>) {
        adapterOptions.push(options);
        return { kind: 'pg-adapter' };
    }),
}));

vi.mock('@/lib/generated/prisma/client', () => ({
    PrismaClient: vi.fn(function PrismaClient() {
        return {
            $extends: (extension: typeof capturedExtension) => {
                capturedExtension = extension;
                return { extended: true };
            },
        };
    }),
}));

/** prisma.ts is mocked globally and builds a singleton at import: load a fresh real copy. */
async function loadPrisma(env: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    globalThis.prismaGlobal = undefined;
    vi.resetModules();
    return (await vi.importActual<typeof import('@/lib/prisma')>('@/lib/prisma')).default;
}

describe('prisma client', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        globalThis.prismaGlobal = undefined;
    });

    it('builds an extended singleton stored on globalThis for warm starts', async () => {
        const prisma = await loadPrisma();

        expect(prisma).toEqual({ extended: true });
        expect(globalThis.prismaGlobal).toBe(prisma);
    });

    it('connects through the pg driver adapter with a connection timeout (Prisma 7)', async () => {
        adapterOptions.length = 0;
        await loadPrisma({ DATABASE_URL: 'postgresql://user@db.example/app' });

        expect(adapterOptions).toEqual([
            { connectionString: 'postgresql://user@db.example/app?uselibpqcompat=true', connectionTimeoutMillis: 10_000 },
        ]);
    });

    it('keeps libpq SSL semantics: sslmode=require no longer verifies the chain under pg 8', async () => {
        const { withLibpqSslSemantics } = await vi.importActual<typeof import('@/lib/prisma')>('@/lib/prisma');

        expect(withLibpqSslSemantics(undefined)).toBeUndefined();
        expect(withLibpqSslSemantics('postgresql://db.example/app?sslmode=require'))
            .toBe('postgresql://db.example/app?sslmode=require&uselibpqcompat=true');
        expect(withLibpqSslSemantics('postgresql://db.example/app?uselibpqcompat=false'))
            .toBe('postgresql://db.example/app?uselibpqcompat=false');
    });

    it('lets pg accept the chain for sslmode=require but still verify verify-full', async () => {
        const { withLibpqSslSemantics } = await vi.importActual<typeof import('@/lib/prisma')>('@/lib/prisma');
        const { parse } = await vi.importActual<typeof import('pg-connection-string')>('pg-connection-string');

        expect(parse(withLibpqSslSemantics('postgresql://db.example/app?sslmode=require')!).ssl)
            .toMatchObject({ rejectUnauthorized: false });
        expect(parse(withLibpqSslSemantics('postgresql://db.example/app?sslmode=verify-full')!).ssl)
            .not.toHaveProperty('rejectUnauthorized', false);
    });

    it('passes query results through and rethrows query errors', async () => {
        await loadPrisma({ NODE_ENV: 'production' });
        const run = capturedExtension!.query.$allOperations;

        await expect(run({ operation: 'findMany', model: 'User', args: {}, query: async () => ['row'] })).resolves.toEqual(['row']);
        await expect(
            run({ operation: '$queryRaw', model: undefined, args: {}, query: async () => { throw new Error('boom'); } }),
        ).rejects.toThrow('boom');
    });

    it('traces every query outside production', async () => {
        await loadPrisma({ NODE_ENV: 'development' });

        await capturedExtension!.query.$allOperations({ operation: 'findUnique', model: 'User', args: {}, query: async () => null });

        expect(logger.debug).toHaveBeenCalledWith('[DB] Query', expect.objectContaining({ query: 'User.findUnique' }));
    });

    it('reports only slow queries in production', async () => {
        vi.useFakeTimers();
        vi.mocked(logger.debug).mockClear();
        await loadPrisma({ NODE_ENV: 'production' });
        const run = capturedExtension!.query.$allOperations;

        await run({ operation: 'findMany', model: 'User', args: {}, query: async () => [] });
        await run({
            operation: 'findMany',
            model: 'EnedisLoadCurve',
            args: {},
            query: async () => { vi.advanceTimersByTime(250); return []; },
        });
        vi.useRealTimers();

        expect(logger.debug).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith('[DB] Slow query', { query: 'EnedisLoadCurve.findMany', durationMs: 250 });
    });
});
