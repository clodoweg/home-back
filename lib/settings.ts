/**
 * System Settings Service
 * Handles reading and writing global configuration values from the SystemSettings table.
 */
import prisma from './prisma';
import { logger } from './logger';

// ─── API Enabled Cache ──────────────────────────────────────────────────────
let apiEnabledCache: { value: boolean; fetchedAt: number } | null = null;
const API_ENABLED_CACHE_TTL = 60_000; // 60 seconds

/** Reset the in-memory cache (for testing). */
export function resetApiEnabledCache(): void {
    apiEnabledCache = null;
}

/**
 * Checks if the API is currently enabled.
 * Cached in-memory for 60s to avoid hitting the DB on every request.
 * Default is true if the record is missing or the database is unreachable.
 *
 * @returns {Promise<boolean>} True if enabled, false otherwise.
 */
export async function isApiEnabled(): Promise<boolean> {
    if (apiEnabledCache && Date.now() - apiEnabledCache.fetchedAt < API_ENABLED_CACHE_TTL) {
        return apiEnabledCache.value;
    }

    try {
        const settings = await prisma.systemSettings.findUnique({
            where: { id: 1 }
        });

        const value = settings ? settings.apiEnabled : true;
        apiEnabledCache = { value, fetchedAt: Date.now() };
        return value;
    } catch (error) {
        // WARNING: fail-open on purpose. The API is the only way to drive the house, so a
        // database outage must not lock everyone out. The last known value wins when there
        // is one, and is cached again so a failing DB is not queried on every request.
        logger.error('[Settings] Error checking API status', { error: String(error) });
        const value = apiEnabledCache?.value ?? true;
        apiEnabledCache = { value, fetchedAt: Date.now() };
        return value;
    }
}
