/** notifications.test — The bell's routes and the Web Push subscription routes (admins only). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMockUsers, mockPrisma, setMockUser } from '../setup';
import { mockAsAdmin, mockAsUser } from '../helpers/mock-auth';
import { ADMIN_USER, STANDARD_USER } from '../helpers/test-users';
import { GET as listNotifications } from '@/app/api/notifications/route';
import { POST as markRead } from '@/app/api/notifications/read/route';
import { POST as subscribe } from '@/app/api/push/subscription/route';
import { POST as unsubscribe } from '@/app/api/push/unsubscribe/route';
import { GET as publicKey } from '@/app/api/push/public-key/route';

const params = Promise.resolve({});
const post = (path: string, body: unknown) =>
    new Request(`http://localhost:3000${path}`, { method: 'POST', body: JSON.stringify(body) });
const validSubscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    keys: { p256dh: 'BKey', auth: 'secret' },
};

describe('notifications API', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearMockUsers();
        mockAsAdmin();
        setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
        delete process.env.VAPID_PUBLIC_KEY;
    });

    describe('GET /api/notifications', () => {
        it('lists the admin\'s latest notifications with the unread count', async () => {
            mockPrisma.notification.findMany.mockResolvedValue([
                {
                    id: 2,
                    category: 'alarm',
                    title: 'Alarme',
                    body: 'Alarme déclenchée',
                    createdAt: new Date('2026-11-16T08:00:00Z'),
                    readAt: null,
                },
                {
                    id: 1,
                    category: 'spa',
                    title: 'Spa',
                    body: 'Spa à 30°',
                    createdAt: new Date('2026-11-15T08:00:00Z'),
                    readAt: new Date('2026-11-15T09:00:00Z'),
                },
            ] as never);
            mockPrisma.notification.count.mockResolvedValue(1);

            const res = await listNotifications(new Request('http://localhost:3000/api/notifications'), { params });

            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({
                notifications: [
                    { id: 2, category: 'alarm', title: 'Alarme', body: 'Alarme déclenchée', createdAt: '2026-11-16T08:00:00.000Z', read: false },
                    { id: 1, category: 'spa', title: 'Spa', body: 'Spa à 30°', createdAt: '2026-11-15T08:00:00.000Z', read: true },
                ],
                unread: 1,
            });
            expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
                expect.objectContaining({ where: { userId: ADMIN_USER.id }, take: 50 }),
            );
        });

        it('is refused to a non-admin', async () => {
            mockAsUser();
            setMockUser(STANDARD_USER.clerkId, STANDARD_USER);
            const res = await listNotifications(new Request('http://localhost:3000/api/notifications'), { params });
            expect(res.status).toBe(403);
            expect(mockPrisma.notification.findMany).not.toHaveBeenCalled();
        });
    });

    describe('POST /api/notifications/read', () => {
        it('marks the given notifications of the caller as read', async () => {
            mockPrisma.notification.updateMany.mockResolvedValue({ count: 2 });
            const res = await markRead(post('/api/notifications/read', { ids: [1, 2] }), { params });
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ updated: 2 });
            expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith({
                where: { userId: ADMIN_USER.id, readAt: null, id: { in: [1, 2] } },
                data: { readAt: expect.any(Date) },
            });
        });

        it('marks every unread notification without ids', async () => {
            mockPrisma.notification.updateMany.mockResolvedValue({ count: 5 });
            await markRead(post('/api/notifications/read', {}), { params });
            expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith({
                where: { userId: ADMIN_USER.id, readAt: null },
                data: { readAt: expect.any(Date) },
            });
        });

        it('rejects invalid ids and non-admins', async () => {
            expect((await markRead(post('/api/notifications/read', { ids: ['x'] }), { params })).status).toBe(400);
            mockAsUser();
            setMockUser(STANDARD_USER.clerkId, STANDARD_USER);
            expect((await markRead(post('/api/notifications/read', {}), { params })).status).toBe(403);
        });
    });

    describe('POST /api/push/subscription', () => {
        it('registers this browser for the admin', async () => {
            const res = await subscribe(post('/api/push/subscription', validSubscription), { params });
            expect(res.status).toBe(201);
            expect(mockPrisma.webPushSubscription.upsert).toHaveBeenCalledWith({
                where: { endpoint: validSubscription.endpoint },
                create: { userId: ADMIN_USER.id, endpoint: validSubscription.endpoint, p256dh: 'BKey', auth: 'secret' },
                update: { userId: ADMIN_USER.id, p256dh: 'BKey', auth: 'secret' },
            });
        });

        it('rejects a non-https endpoint, missing keys and non-admins', async () => {
            expect(
                (await subscribe(post('/api/push/subscription', { ...validSubscription, endpoint: 'http://x.test/a' }), { params })).status,
            ).toBe(400);
            expect((await subscribe(post('/api/push/subscription', { endpoint: validSubscription.endpoint }), { params })).status).toBe(400);
            mockAsUser();
            setMockUser(STANDARD_USER.clerkId, STANDARD_USER);
            expect((await subscribe(post('/api/push/subscription', validSubscription), { params })).status).toBe(403);
            expect(mockPrisma.webPushSubscription.upsert).not.toHaveBeenCalled();
        });
    });

    describe('POST /api/push/unsubscribe', () => {
        it('forgets the caller\'s subscription only', async () => {
            mockPrisma.webPushSubscription.deleteMany.mockResolvedValue({ count: 1 });
            const res = await unsubscribe(post('/api/push/unsubscribe', { endpoint: validSubscription.endpoint }), { params });
            expect(await res.json()).toEqual({ deleted: 1 });
            expect(mockPrisma.webPushSubscription.deleteMany).toHaveBeenCalledWith({
                where: { userId: ADMIN_USER.id, endpoint: validSubscription.endpoint },
            });
        });

        it('rejects a missing endpoint', async () => {
            expect((await unsubscribe(post('/api/push/unsubscribe', {}), { params })).status).toBe(400);
        });
    });

    describe('GET /api/push/public-key', () => {
        it('gives the public VAPID key to an admin, null when push is off', async () => {
            const request = () => new Request('http://localhost:3000/api/push/public-key');
            expect(await (await publicKey(request(), { params })).json()).toEqual({ publicKey: null });
            process.env.VAPID_PUBLIC_KEY = 'BPublic';
            expect(await (await publicKey(request(), { params })).json()).toEqual({ publicKey: 'BPublic' });
            mockAsUser();
            setMockUser(STANDARD_USER.clerkId, STANDARD_USER);
            expect((await publicKey(request(), { params })).status).toBe(403);
            delete process.env.VAPID_PUBLIC_KEY;
        });
    });
});
