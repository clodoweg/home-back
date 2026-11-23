/**
 * notifications — Alerts as the front's bell lists them (stored per admin, kept 30 days) and as
 * Web Push notifications on the devices that subscribed. Fed by the alert runner; never makes it
 * fail.
 */
// web-push 4 is an ES module without a default export: a default import is undefined at runtime.
import * as webpush from 'web-push';

import prisma from '@/lib/prisma';
import { logger } from '@/lib/logger';
import type { AlertCategory, AlertEvent } from '@/lib/integrations/alerts/types';

/** Notifications older than this are deleted. */
export const NOTIFICATION_RETENTION_DAYS = 30;

/** How long a push service keeps an undelivered notification (device offline). */
const PUSH_TTL_SECONDS = 60 * 60;

/** Title of a notification, by alert category. */
export const CATEGORY_TITLES: Record<AlertCategory, string> = {
    alarm: 'Alarme',
    lights: 'Lumières',
    spa: 'Spa',
    fountain: 'Fontaine',
    feeder: 'Croquettes',
    humidity: 'Humidité',
    motion: 'Mouvement',
    temperature: 'Température',
    washingMachine: 'Lave-linge',
    printer: 'Imprimante 3D',
};

const ENTITIES: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&nbsp;': ' ',
};

/**
 * Drops every tag, repeating until nothing changes: a tag split by another (`<scr<b>ipt>`) would
 * come back whole after a single pass. `[^<>]` keeps each pass linear (no backtracking).
 */
function stripTags(text: string): string {
    let previous: string;
    let current = text;
    do {
        previous = current;
        current = current.replace(/<[^<>]*>/g, '');
    } while (current !== previous);
    return current;
}

/**
 * Plain text of an alert message: line breaks kept, tags dropped, entities decoded.
 *
 * @param html - Alert message, with its light HTML markup.
 * @returns The text, trimmed, without blank lines.
 */
export function htmlToText(html: string): string {
    return stripTags(html.replace(/<br\s*\/?>/gi, '\n'))
        .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity])
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join('\n');
}

/**
 * Public VAPID key the browsers subscribe with, or null when push is not configured.
 *
 * @returns The key from `VAPID_PUBLIC_KEY`.
 */
export function vapidPublicKey(): string | null {
    return process.env.VAPID_PUBLIC_KEY || null;
}

/**
 * Configures web-push from the environment.
 *
 * @returns Whether the three VAPID variables are set.
 */
function configureWebPush(): boolean {
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    const subject = process.env.VAPID_SUBJECT;
    if (!publicKey || !privateKey || !subject) return false;
    webpush.setVapidDetails(subject, publicKey, privateKey);
    return true;
}

/** Status codes by which a push service says the subscription no longer exists. */
const GONE_STATUSES = new Set([404, 410]);

/**
 * Stores an alert for a user's bell and pushes it to the user's subscribed devices. Failures
 * are logged, never thrown: the other admins must still be notified.
 *
 * @param userId - Recipient (an admin).
 * @param event - The alert.
 * @returns Whether the notification was stored.
 */
export async function notifyUser(userId: number, event: AlertEvent): Promise<boolean> {
    const title = CATEGORY_TITLES[event.category];
    const body = htmlToText(event.message);

    let notificationId: number;
    try {
        const stored = await prisma.notification.create({
            data: { userId, category: event.category, title, body },
            select: { id: true },
        });
        notificationId = stored.id;
    } catch (error) {
        logger.error('[Notifications] Failed to store notification', { error: String(error) });
        return false;
    }

    if (!configureWebPush()) return true;

    const subscriptions = await prisma.webPushSubscription
        .findMany({ where: { userId } })
        .catch((error: unknown) => {
            logger.error('[Notifications] Failed to load push subscriptions', { error: String(error) });
            return [];
        });
    const payload = JSON.stringify({ id: notificationId, title, body, category: event.category });

    await Promise.all(
        subscriptions.map(async (subscription) => {
            try {
                await webpush.sendNotification(
                    { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
                    payload,
                    { TTL: PUSH_TTL_SECONDS },
                );
            } catch (error) {
                const status = (error as { statusCode?: number }).statusCode;
                if (status && GONE_STATUSES.has(status)) {
                    // The browser unsubscribed or the app was uninstalled: forget the device.
                    await prisma.webPushSubscription
                        .delete({ where: { endpoint: subscription.endpoint } })
                        .catch(() => undefined);
                } else {
                    logger.warn('[Notifications] Push delivery failed', { status });
                }
            }
        }),
    );
    return true;
}

/**
 * Deletes the notifications older than {@link NOTIFICATION_RETENTION_DAYS}.
 *
 * @returns How many were deleted (0 on failure).
 */
export async function pruneOldNotifications(): Promise<number> {
    const cutoff = new Date(Date.now() - NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    try {
        const { count } = await prisma.notification.deleteMany({ where: { createdAt: { lt: cutoff } } });
        return count;
    } catch (error) {
        logger.error('[Notifications] Failed to prune old notifications', { error: String(error) });
        return 0;
    }
}
