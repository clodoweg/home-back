/**
 * Redis — client Upstash partagé (rate limit, alertes de sécurité, anti-répétition Telegram).
 * Null when Upstash is not configured or disabled with ENABLE_UPSTASH_REDIS=false: each
 * caller then falls back on its own in-memory behaviour.
 */
import { Redis } from '@upstash/redis';

const isConfigured =
    !!process.env.UPSTASH_REDIS_REST_URL &&
    !!process.env.UPSTASH_REDIS_REST_TOKEN &&
    process.env.ENABLE_UPSTASH_REDIS !== 'false';

export const redis = isConfigured
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL!,
        token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    })
    : null;
