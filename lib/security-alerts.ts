/**
 * Security Auditing & Alerts
 * Tracks suspicious activities and manages notifications for critical security events.
 * 
 * WARNING: This module is critical for detecting brute-force and unauthorized access.
 */

import { logger } from '@/lib/logger';
import { redis } from '@/lib/redis';

interface SecurityEvent {
    type: 'auth_failure' | 'permission_denied' | 'rate_limit' | 'suspicious_activity';
    ip: string;
    path?: string;
    userId?: string;
    userEmail?: string;
    entityId?: string;
    requestId?: string;
    details?: string;
}

// ─── Configuration ─────────────────────────────────────────────────────────────

const ALERT_THRESHOLD = 5;        // Alert after N failed attempts
const WINDOW_SECONDS = 15 * 60;   // 15-minute sliding window (Redis TTL)
const SLACK_WEBHOOK_URL = process.env.SECURITY_SLACK_WEBHOOK;
const DISCORD_WEBHOOK_URL = process.env.SECURITY_DISCORD_WEBHOOK;


// Local fallback (per-instance, resets on cold start), with the same window as Redis and a
// bounded size: the keys come from client IPs.
const LOCAL_MAX_KEYS = 1000;
const localFallback = new Map<string, { count: number; windowStart: number }>();

async function incrementAttempt(key: string): Promise<number> {
    const redisKey = `security:${key}`;

    if (redis) {
        // INCR atomically increments, EXPIRE sets TTL only on the first call
        const count = await redis.incr(redisKey);
        if (count === 1) {
            // First attempt in this window — set the expiry
            await redis.expire(redisKey, WINDOW_SECONDS);
        }
        return count;
    }

    const now = Date.now();
    const current = localFallback.get(key);
    if (current && now - current.windowStart < WINDOW_SECONDS * 1000) {
        current.count += 1;
        return current.count;
    }

    if (localFallback.size >= LOCAL_MAX_KEYS) {
        for (const [k, entry] of localFallback) {
            if (now - entry.windowStart >= WINDOW_SECONDS * 1000) localFallback.delete(k);
        }
        if (localFallback.size >= LOCAL_MAX_KEYS) localFallback.delete(localFallback.keys().next().value as string);
    }
    localFallback.delete(key);
    localFallback.set(key, { count: 1, windowStart: now });
    return 1;
}

export async function trackSecurityEvent(event: SecurityEvent): Promise<void> {
    const key = `${event.type}:${event.ip}`;

    logger.security(`Security event: ${event.type}`, {
        ip: event.ip,
        path: event.path,
        userId: event.userId,
        userEmail: event.userEmail,
        entityId: event.entityId,
        requestId: event.requestId,
        details: event.details,
    });

    try {
        const count = await incrementAttempt(key);

        if (count === ALERT_THRESHOLD) {
            await sendSecurityAlert({
                ...event,
                attemptCount: count,
                windowMinutes: WINDOW_SECONDS / 60,
            });
        }
    } catch (e) {
        // Never let alert tracking crash the request
        logger.error('Failed to track security event', { error: String(e) });
    }
}

/**
 * Send alert to configured channels
 */
async function sendSecurityAlert(event: SecurityEvent & { attemptCount: number; windowMinutes: number }): Promise<void> {
    const message = formatAlertMessage(event);

    logger.warn('Security alert triggered', {
        type: event.type,
        ip: event.ip,
        attemptCount: event.attemptCount,
    });

    // Send to Slack if configured
    if (SLACK_WEBHOOK_URL) {
        try {
            await fetch(SLACK_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: `🚨 Security Alert: ${event.type}`,
                    blocks: [
                        {
                            type: 'section',
                            text: { type: 'mrkdwn', text: message },
                        },
                    ],
                }),
            });
        } catch (e) {
            logger.error('Failed to send Slack alert', { error: String(e) });
        }
    }

    // Send to Discord if configured
    if (DISCORD_WEBHOOK_URL) {
        try {
            await fetch(DISCORD_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: `🚨 **Security Alert**\n${message}`,
                }),
            });
        } catch (e) {
            logger.error('Failed to send Discord alert', { error: String(e) });
        }
    }
}

/**
 * Format alert message for notifications
 */
function formatAlertMessage(event: SecurityEvent & { attemptCount: number; windowMinutes: number }): string {
    const lines = [
        `**Type:** ${event.type.replace('_', ' ').toUpperCase()}`,
        `**IP:** \`${event.ip}\``,
        `**Attempts:** ${event.attemptCount} in ${event.windowMinutes} minutes`,
    ];

    if (event.path) lines.push(`**Path:** \`${event.path}\``);
    if (event.userEmail) lines.push(`**Email:** ${event.userEmail}`);
    if (event.entityId) lines.push(`**Entity:** \`${event.entityId}\``);
    if (event.details) lines.push(`**Details:** ${event.details}`);

    lines.push(`**Time:** ${new Date().toISOString()}`);

    return lines.join('\n');
}
