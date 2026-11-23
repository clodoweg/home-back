/** notifications.test — Alerts stored for the bell and pushed to the subscribed devices. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrisma } from '../setup';

// Same shape as web-push 4 (ES module): named exports only, no default export.
vi.mock('web-push', () => ({ setVapidDetails: vi.fn(), sendNotification: vi.fn() }));

import * as webpush from 'web-push';
import {
    htmlToText,
    notifyUser,
    pruneOldNotifications,
    vapidPublicKey,
} from '@/lib/integrations/notifications';

const event = {
    category: 'alarm' as const,
    throttleKey: 'alarm',
    message: '🚨 <b>Alarme</b> déclenchée<br/>Salon &amp; entrée',
};

const subscription = (endpoint: string) => ({
    id: 1,
    userId: 1,
    endpoint,
    p256dh: 'key',
    auth: 'secret',
    createdAt: new Date(),
});

const setVapid = () => {
    process.env.VAPID_PUBLIC_KEY = 'public';
    process.env.VAPID_PRIVATE_KEY = 'private';
    process.env.VAPID_SUBJECT = 'mailto:admin@test.home';
};

describe('notifications', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockPrisma.notification.create.mockResolvedValue({ id: 7 } as never);
    });
    afterEach(() => {
        delete process.env.VAPID_PUBLIC_KEY;
        delete process.env.VAPID_PRIVATE_KEY;
        delete process.env.VAPID_SUBJECT;
    });

    describe('htmlToText', () => {
        it('keeps line breaks, drops tags and decodes entities', () => {
            expect(htmlToText(event.message)).toBe('🚨 Alarme déclenchée\nSalon & entrée');
            expect(htmlToText('a &lt; b &gt; c &quot;d&quot; &#39;e&#39;&nbsp;f\n\n  g')).toBe(
                'a < b > c "d" \'e\' f\ng',
            );
        });

        it('leaves no tag behind when tags are nested to rebuild one', () => {
            expect(htmlToText('<scr<b>ipt>alert(1)</scr</b>ipt>')).toBe('alert(1)');
        });
    });

    it('exposes the public VAPID key, or null when push is off', () => {
        expect(vapidPublicKey()).toBeNull();
        setVapid();
        expect(vapidPublicKey()).toBe('public');
    });

    it('stores the alert for the bell, titled by category, without push when VAPID is not set', async () => {
        expect(await notifyUser(1, event)).toBe(true);
        expect(mockPrisma.notification.create).toHaveBeenCalledWith({
            data: { userId: 1, category: 'alarm', title: 'Alarme', body: '🚨 Alarme déclenchée\nSalon & entrée' },
            select: { id: true },
        });
        expect(webpush.sendNotification).not.toHaveBeenCalled();
    });

    it('pushes the alert to every subscribed device', async () => {
        setVapid();
        mockPrisma.webPushSubscription.findMany.mockResolvedValue([
            subscription('https://push.example/a'),
            subscription('https://push.example/b'),
        ] as never);
        vi.mocked(webpush.sendNotification).mockResolvedValue({} as never);

        await notifyUser(1, event);

        expect(webpush.setVapidDetails).toHaveBeenCalledWith('mailto:admin@test.home', 'public', 'private');
        expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
        expect(webpush.sendNotification).toHaveBeenCalledWith(
            { endpoint: 'https://push.example/a', keys: { p256dh: 'key', auth: 'secret' } },
            JSON.stringify({ id: 7, title: 'Alarme', body: '🚨 Alarme déclenchée\nSalon & entrée', category: 'alarm' }),
            { TTL: 3600 },
        );
    });

    it('forgets a device the push service no longer knows, keeps the others', async () => {
        setVapid();
        mockPrisma.webPushSubscription.findMany.mockResolvedValue([
            subscription('https://push.example/gone'),
            subscription('https://push.example/flaky'),
        ] as never);
        mockPrisma.webPushSubscription.delete.mockResolvedValue({} as never);
        vi.mocked(webpush.sendNotification)
            .mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }))
            .mockRejectedValueOnce(Object.assign(new Error('server'), { statusCode: 500 }));

        expect(await notifyUser(1, event)).toBe(true);
        expect(mockPrisma.webPushSubscription.delete).toHaveBeenCalledTimes(1);
        expect(mockPrisma.webPushSubscription.delete).toHaveBeenCalledWith({
            where: { endpoint: 'https://push.example/gone' },
        });
    });

    it('never throws: a storage failure is logged and reported', async () => {
        mockPrisma.notification.create.mockRejectedValue(new Error('db down'));
        expect(await notifyUser(1, event)).toBe(false);
    });

    it('still reports the notification stored when the subscriptions cannot be read', async () => {
        setVapid();
        mockPrisma.webPushSubscription.findMany.mockRejectedValue(new Error('db down'));
        expect(await notifyUser(1, event)).toBe(true);
        expect(webpush.sendNotification).not.toHaveBeenCalled();
    });

    it('deletes the notifications older than 30 days', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
        mockPrisma.notification.deleteMany.mockResolvedValue({ count: 3 });

        expect(await pruneOldNotifications()).toBe(3);
        expect(mockPrisma.notification.deleteMany).toHaveBeenCalledWith({
            where: { createdAt: { lt: new Date('2026-10-17T12:00:00Z') } },
        });
        vi.useRealTimers();
    });

    it('prunes nothing when the database fails', async () => {
        mockPrisma.notification.deleteMany.mockRejectedValue(new Error('db down'));
        expect(await pruneOldNotifications()).toBe(0);
    });
});
