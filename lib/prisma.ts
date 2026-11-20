/**
 * Database Client
 * Singleton instance of Prisma Client for database operations (PostgreSQL on Supabase).
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/lib/generated/prisma/client';
import { logger } from '@/lib/logger';

const isProduction = process.env.NODE_ENV === 'production';
const SLOW_QUERY_MS = 100;
/**
 * WARNING: performance — node-postgres has no connection timeout by default. An unreachable
 * database or a saturated pooler must not hold the request: beyond 10 s it fails instead of
 * hanging until the Vercel function limit.
 */
export const CONNECTION_TIMEOUT_MS = 10_000;

/**
 * Applies standard libpq SSL semantics to a connection string, as Prisma 5's engine did.
 * WARNING: security — pg 8 treats `sslmode=require` as `verify-full` and rejects the database's
 * certificate chain ("self-signed certificate in certificate chain"). With libpq semantics,
 * `require` encrypts without verifying the chain; `verify-full` in the URL still verifies it.
 *
 * @param connectionString - Database URL, possibly undefined.
 * @returns The URL with `uselibpqcompat=true`, unless it already sets the option.
 */
export function withLibpqSslSemantics(connectionString: string | undefined): string | undefined {
    if (!connectionString || /[?&]uselibpqcompat=/i.test(connectionString)) return connectionString;
    return `${connectionString}${connectionString.includes('?') ? '&' : '?'}uselibpqcompat=true`;
}

const prismaClientSingleton = () => {
    // Prisma 7 requires a driver adapter; DATABASE_URL is Supabase's transaction pooler (port 6543)
    const adapter = new PrismaPg({ connectionString: withLibpqSslSemantics(process.env.DATABASE_URL), connectionTimeoutMillis: CONNECTION_TIMEOUT_MS });
    const client = new PrismaClient({ adapter });

    return client.$extends({
        query: {
            async $allOperations({ operation, model, args, query }: {
                operation: string;
                model?: string;
                args: unknown;
                query: (args: unknown) => Promise<unknown>;
            }) {
                const start = Date.now();

                try {
                    const result = await query(args);
                    const duration = Date.now() - start;

                    const queryName = `${model ? model + '.' : ''}${operation}`;
                    // Every query is traced in development; production only reports slow ones
                    if (duration > SLOW_QUERY_MS) {
                        logger.warn('[DB] Slow query', { query: queryName, durationMs: duration });
                    } else if (!isProduction) {
                        logger.debug('[DB] Query', { query: queryName, durationMs: duration });
                    }
                    return result;
                } catch (error) {
                    const duration = Date.now() - start;
                    logger.error('[DB] Query failed', { query: `${model ? model + '.' : ''}${operation}`, durationMs: duration });
                    throw error;
                }
            },
        },
    });
};

export type ExtendedPrismaClient = ReturnType<typeof prismaClientSingleton>;

declare global {
    var prismaGlobal: undefined | ExtendedPrismaClient;
}

// We always use a singleton, even in production, to help connection reuse in serverless warm starts
const prisma = globalThis.prismaGlobal ?? prismaClientSingleton();

export default prisma;

globalThis.prismaGlobal = prisma;
