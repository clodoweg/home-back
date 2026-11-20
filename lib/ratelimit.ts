/**
 * Rate Limiting Service
 * Provides protection against brute-force and DDoS using Upstash Redis sliding windows.
 * 
 * WARNING: Misconfiguration can lead to service denial or brute-force vulnerability.
 */

import { Ratelimit } from '@upstash/ratelimit';
import { logger } from './logger';
import { redis } from './redis';

/**
 * General API rate limiter
 * 300 requests per minute per IP
 */
export const apiRatelimit = redis
    ? new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(300, '1m'),
        prefix: 'ratelimit:api:',
        analytics: false,
    })
    : null;

export const strictRatelimit = redis
    ? new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(30, '1m'),
        prefix: 'ratelimit:strict:',
        analytics: false,
    })
    : null;

/**
 * Relaxed rate limiter for media/images
 * 600 requests per minute per IP
 */
export const imageRatelimit = redis
    ? new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(600, '1m'),
        prefix: 'ratelimit:image:',
        analytics: false,
    })
    : null;

/**
 * Rate limit check helper.
 * 
 * @param limiter - The Ratelimit instance to use.
 * @param identifier - Unique identifier (usually IP).
 * @returns Object with success status and remaining quota.
 */
export async function checkRateLimit(
    limiter: Ratelimit | null,
    identifier: string
): Promise<{ success: boolean; remaining?: number; reset?: number }> {
    if (!limiter) {
        // Rate limiting not configured, allow request
        return { success: true };
    }

    try {
        const result = await limiter.limit(identifier);
        return {
            success: result.success,
            remaining: result.remaining,
            reset: result.reset,
        };
    } catch (error) {
        // Fail open: an Upstash outage must not take the whole API down with a 500
        logger.error('Rate limit check failed, request allowed', { error: String(error) });
        return { success: true };
    }
}
