/**
 * Telegram alert throttle — 5 min per (user, throttleKey).
 * Redis when available, in-memory fallback with timestamps otherwise.
 */
import { redis } from '@/lib/redis';

const THROTTLE_SECONDS = 5 * 60;

const localFallback = new Map<string, number>();

export async function shouldEmit(userId: number, throttleKey: string): Promise<boolean> {
    const key = `alert:${userId}:${throttleKey}`;

    if (redis) {
        // SET NX with TTL: returns 'OK' if set (= allowed), null if already exists (= throttled).
        const result = await redis.set(key, '1', { nx: true, ex: THROTTLE_SECONDS });
        return result === 'OK';
    }

    const now = Date.now();
    const last = localFallback.get(key);
    if (last && now - last < THROTTLE_SECONDS * 1000) return false;
    localFallback.set(key, now);
    return true;
}
