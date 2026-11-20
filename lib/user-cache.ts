import { getUser, type AuthUser } from './user';

/**
 * In-memory User Cache
 * Offloads database pressure for frequent authorization checks with a 5-minute TTL.
 * 
 * WARNING: Authorization data is cached. Ensure cache invalidation on critical permission changes.
 */

interface CachedUser {
    user: AuthUser;
    fetchedAt: number;
}

const cache = new Map<string, CachedUser>();
const TTL_MS = 300_000; // 5 minutes

/**
 * Get a user by Clerk ID, returning a cached version if available and fresh.
 * 
 * @param clerkId - The unique Clerk user ID.
 * @returns The Prisma User object or null.
 */
export async function getCachedUser(clerkId: string): Promise<AuthUser | null> {
    const cached = cache.get(clerkId);
    if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
        return cached.user;
    }

    const user = await getUser(clerkId);
    if (user) {
        cache.set(clerkId, { user, fetchedAt: Date.now() });
    } else {
        // Remove stale entry if user no longer exists
        cache.delete(clerkId);
    }
    return user;
}

/**
 * Invalidate a specific user from the cache.
 * 
 * @param clerkId - The unique Clerk user ID.
 */
export function invalidateUserCache(clerkId: string): void {
    cache.delete(clerkId);
}
