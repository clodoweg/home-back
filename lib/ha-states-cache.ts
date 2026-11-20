/**
 * Shared in-memory cache for HA states.
 * Absorbs burst polling from multiple routes without hammering HA.
 */
import { haFetch, type HAState } from '@/lib/haClient';

interface StatesCache {
    data: HAState[];
    fetchedAt: number;
}

let statesCache: StatesCache | null = null;
let inFlight: Promise<{ data: HAState[]; ok: boolean }> | null = null;
const STATES_CACHE_TTL = 5_000; // 5 seconds

/** Empties the cache (tests). */
export function resetStatesCache(): void {
    statesCache = null;
    inFlight = null;
}

/**
 * Current HA states, cached for 5 seconds. Concurrent callers share the same HA call
 * instead of each fetching the full state list (Fluid compute serves them in one instance).
 *
 * @returns The states, and whether HA answered.
 */
export async function getCachedStates(): Promise<{ data: HAState[]; ok: boolean }> {
    if (statesCache && Date.now() - statesCache.fetchedAt < STATES_CACHE_TTL) {
        return { data: statesCache.data, ok: true };
    }
    if (inFlight) return inFlight;

    inFlight = (async () => {
        try {
            const { data, ok } = await haFetch<HAState[]>('/api/states', { label: 'states' });
            if (ok && Array.isArray(data)) {
                statesCache = { data, fetchedAt: Date.now() };
            }
            return { data: data ?? [], ok };
        } finally {
            inFlight = null;
        }
    })();
    return inFlight;
}
