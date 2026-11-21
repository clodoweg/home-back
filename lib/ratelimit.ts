/**
 * Rate Limiting Service
 * Sliding windows on Upstash Redis, shared by every server instance. When Upstash is not configured
 * or fails, a fixed window kept in the memory of each instance takes over: the API is never
 * unlimited (audit M3), and an Upstash outage still never turns into a 500.
 *
 * WARNING: Misconfiguration can lead to service denial or brute-force vulnerability.
 */

import { Ratelimit } from '@upstash/ratelimit';
import { logger } from './logger';
import { redis } from './redis';

interface RateLimitResult {
    success: boolean;
    remaining?: number;
    reset?: number;
}

const WINDOW = '1m';
const WINDOW_MS = 60_000;

/**
 * Fixed window counter per identifier, local to one server instance. Weaker than Upstash (each
 * instance counts on its own), but warm instances are reused, so it still caps a single caller.
 */
export class MemoryRateLimiter {
    private readonly windows = new Map<string, { count: number; resetAt: number }>();

    /**
     * @param requests - Requests allowed per window.
     * @param windowMs - Window length in milliseconds.
     * @param maxIdentifiers - Identifiers kept at most, so that rotating IPs cannot grow the map forever.
     */
    constructor(
        private readonly requests: number,
        private readonly windowMs: number,
        private readonly maxIdentifiers = 10_000,
    ) {}

    /**
     * Counts one request for an identifier.
     *
     * @param identifier - Usually the client IP, or `user:<clerkId>`.
     * @param now - Current time in milliseconds (tests).
     * @returns Whether the request is allowed, the quota left and the end of the window.
     */
    limit(identifier: string, now = Date.now()): RateLimitResult {
        let window = this.windows.get(identifier);
        if (!window || now >= window.resetAt) {
            if (!window && this.windows.size >= this.maxIdentifiers) this.evict(now);
            window = { count: 0, resetAt: now + this.windowMs };
            this.windows.set(identifier, window);
        }
        window.count += 1;
        return {
            success: window.count <= this.requests,
            remaining: Math.max(0, this.requests - window.count),
            reset: window.resetAt,
        };
    }

    /** Drops the expired windows, then the oldest one if the map is still full. */
    private evict(now: number): void {
        for (const [identifier, window] of this.windows) {
            if (now >= window.resetAt) this.windows.delete(identifier);
        }
        if (this.windows.size >= this.maxIdentifiers) {
            this.windows.delete(this.windows.keys().next().value as string);
        }
    }
}

/** A limit: shared through Upstash when available, with its in-memory fallback. */
export interface RateLimiter {
    upstash: Ratelimit | null;
    memory: MemoryRateLimiter;
}

function createRateLimiter(prefix: string, requestsPerMinute: number): RateLimiter {
    return {
        upstash: redis
            ? new Ratelimit({
                redis,
                limiter: Ratelimit.slidingWindow(requestsPerMinute, WINDOW),
                prefix,
                analytics: false,
            })
            : null,
        memory: new MemoryRateLimiter(requestsPerMinute, WINDOW_MS),
    };
}

/** General API rate limiter: 300 requests per minute per IP. */
export const apiRatelimit = createRateLimiter('ratelimit:api:', 300);

/** HA service calls and snapshots: 30 requests per minute per IP, and per user. */
export const strictRatelimit = createRateLimiter('ratelimit:strict:', 30);

/** Relaxed rate limiter for media/images: 600 requests per minute per IP. */
export const imageRatelimit = createRateLimiter('ratelimit:image:', 600);

if (!redis && process.env.NODE_ENV === 'production') {
    logger.error('Upstash Redis is not configured: rate limits only apply per server instance (in memory)');
}

/**
 * Rate limit check helper.
 *
 * @param limiter - The limit to apply.
 * @param identifier - Unique identifier (usually IP).
 * @returns Object with success status and remaining quota.
 */
export async function checkRateLimit(limiter: RateLimiter, identifier: string): Promise<RateLimitResult> {
    if (limiter.upstash) {
        try {
            const result = await limiter.upstash.limit(identifier);
            return {
                success: result.success,
                remaining: result.remaining,
                reset: result.reset,
            };
        } catch (error) {
            logger.error('Rate limit check failed on Upstash, in-memory limit applied', { error: String(error) });
        }
    }
    return limiter.memory.limit(identifier);
}
