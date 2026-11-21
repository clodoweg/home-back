import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockPrisma } from '../setup';
import { assertHAConfig, env, hasHAConfig } from '@/lib/env';
import { isApiEnabled, resetApiEnabledCache } from '@/lib/settings';

describe('env', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('cleans quotes, spaces and trailing slashes', () => {
        vi.stubEnv('HA_BASE_URL', ' "http://ha.local:8123//" ');
        vi.stubEnv('HA_ACCESS_TOKEN', '"token"');

        expect(env.HA_BASE_URL).toBe('http://ha.local:8123');
        expect(env.HA_ACCESS_TOKEN).toBe('token');
        expect(hasHAConfig()).toBe(true);
        expect(() => assertHAConfig()).not.toThrow();
    });

    it('reports a missing HA configuration', () => {
        vi.stubEnv('HA_ACCESS_TOKEN', '');

        expect(hasHAConfig()).toBe(false);
        expect(() => assertHAConfig()).toThrow('Missing HA_BASE_URL or HA_ACCESS_TOKEN');
    });
});

describe('settings — API kill switch', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetApiEnabledCache();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('reads the flag once per minute', async () => {
        vi.useFakeTimers({ now: new Date(Date.UTC(2026, 9, 22)) });
        mockPrisma.systemSettings.findUnique.mockResolvedValue({ id: 1, apiEnabled: false } as never);

        expect(await isApiEnabled()).toBe(false);
        expect(await isApiEnabled()).toBe(false);
        expect(mockPrisma.systemSettings.findUnique).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(60_001);
        await isApiEnabled();
        expect(mockPrisma.systemSettings.findUnique).toHaveBeenCalledTimes(2);
    });

    it('is enabled when the settings row does not exist', async () => {
        mockPrisma.systemSettings.findUnique.mockResolvedValue(null);
        expect(await isApiEnabled()).toBe(true);
    });

    it('fails open on a DB error, keeping the last known value and caching it', async () => {
        vi.useFakeTimers({ now: new Date(Date.UTC(2026, 9, 22)) });
        mockPrisma.systemSettings.findUnique.mockResolvedValueOnce({ id: 1, apiEnabled: false } as never);
        await isApiEnabled();

        vi.advanceTimersByTime(60_001);
        mockPrisma.systemSettings.findUnique.mockRejectedValue(new Error('db down'));
        expect(await isApiEnabled()).toBe(false);
        expect(await isApiEnabled()).toBe(false);
        expect(mockPrisma.systemSettings.findUnique).toHaveBeenCalledTimes(2);

        resetApiEnabledCache();
        expect(await isApiEnabled()).toBe(true);
    });
});

describe('user provisioning', () => {
    /** ADMIN_EMAILS and ALLOWED_EMAILS are read at import: load a fresh copy per scenario. */
    async function loadUser(adminEmails: string, allowedEmails = '') {
        vi.stubEnv('ADMIN_EMAILS', adminEmails);
        vi.stubEnv('ALLOWED_EMAILS', allowedEmails);
        vi.resetModules();
        return import('@/lib/user');
    }

    beforeEach(() => {
        vi.clearAllMocks();
        mockPrisma.userGroup.findUnique.mockImplementation((async ({ where }: { where: { name: string } }) =>
            ({ name: where.name, permissions: where.name === 'admin' ? ['remote', 'history'] : [] })) as never);
        mockPrisma.user.upsert.mockImplementation((async (args: { create: unknown }) => args.create) as never);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('provisions an email listed in ADMIN_EMAILS as admin, case-insensitively', async () => {
        const { getOrCreateUser } = await loadUser(' Parent@Example.org , other@example.org');

        const user = await getOrCreateUser('clerk_1', 'parent@example.org');

        expect(user).toMatchObject({ clerkId: 'clerk_1', group: 'admin' });
    });

    it('provisions any other email as user', async () => {
        const { getOrCreateUser } = await loadUser('parent@example.org');

        expect(await getOrCreateUser('clerk_2', 'kid@example.org')).toMatchObject({ group: 'user' });
    });

    it('promotes nobody when ADMIN_EMAILS is empty (no hard-coded fallback)', async () => {
        const { getOrCreateUser } = await loadUser('');

        expect(await getOrCreateUser('clerk_3', 'owner@example.org')).toMatchObject({ group: 'user' });
    });

    it('keeps the email in sync on existing users without touching their group', async () => {
        const { getOrCreateUser } = await loadUser('parent@example.org');

        await getOrCreateUser('clerk_1', 'new@example.org');

        expect(mockPrisma.user.upsert).toHaveBeenCalledWith(expect.objectContaining({
            where: { clerkId: 'clerk_1' },
            update: { email: 'new@example.org' },
        }));
    });

    it('creates the default groups and adds the missing admin permissions', async () => {
        const { getOrCreateUser } = await loadUser('');
        mockPrisma.userGroup.findUnique.mockImplementation((async ({ where }: { where: { name: string } }) =>
            where.name === 'children' ? null : { name: where.name, permissions: where.name === 'admin' ? ['remote'] : [] }) as never);

        await getOrCreateUser('clerk_4', 'x@example.org');

        expect(mockPrisma.userGroup.create).toHaveBeenCalledWith({ data: { name: 'children', permissions: [] } });
        expect(mockPrisma.userGroup.update).toHaveBeenCalledWith({
            where: { name: 'admin' },
            data: { permissions: { set: ['remote', 'history', 'cameras', 'admin'] } },
        });
    });

    it('reads a user with its group', async () => {
        const { getUser } = await loadUser('');
        mockPrisma.user.findUnique.mockResolvedValue({ id: 1 } as never);

        expect(await getUser('clerk_1')).toEqual({ id: 1 });
        expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({ where: { clerkId: 'clerk_1' }, include: { userGroup: true } });
    });

    describe('allowlist (audit H1)', () => {
        it('allows the emails of ALLOWED_EMAILS and ADMIN_EMAILS, case-insensitively', async () => {
            const { canProvisionEmail } = await loadUser('parent@example.org', ' Kid@Example.org , grandma@example.org');

            expect(canProvisionEmail('kid@example.org')).toBe(true);
            expect(canProvisionEmail(' GRANDMA@example.org ')).toBe(true);
            expect(canProvisionEmail('Parent@Example.org')).toBe(true);
        });

        it('refuses any other email, and the empty one', async () => {
            const { canProvisionEmail } = await loadUser('parent@example.org', 'kid@example.org');

            expect(canProvisionEmail('stranger@gmail.example')).toBe(false);
            expect(canProvisionEmail('kid@example.org.evil.example')).toBe(false);
            expect(canProvisionEmail('')).toBe(false);
        });

        it('refuses everyone when both lists are empty', async () => {
            const { canProvisionEmail } = await loadUser('', '');

            expect(canProvisionEmail('owner@example.org')).toBe(false);
        });
    });

    describe('provisionUser', () => {
        it('writes nothing for an email that is not allowed', async () => {
            const { provisionUser } = await loadUser('parent@example.org', 'kid@example.org');

            expect(await provisionUser('clerk_9', 'stranger@gmail.example')).toBeNull();
            expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
            expect(mockPrisma.user.upsert).not.toHaveBeenCalled();
            expect(mockPrisma.user.update).not.toHaveBeenCalled();
        });

        it('creates an allowed account as user, an admin email as admin', async () => {
            const { provisionUser } = await loadUser('parent@example.org', 'kid@example.org');
            mockPrisma.user.findFirst.mockResolvedValue(null);

            expect(await provisionUser('clerk_kid', 'kid@example.org')).toMatchObject({ clerkId: 'clerk_kid', group: 'user' });
            expect(await provisionUser('clerk_parent', 'parent@example.org')).toMatchObject({ clerkId: 'clerk_parent', group: 'admin' });
        });

        it('re-attaches the row already holding this email, keeping its group and preferences', async () => {
            const { provisionUser } = await loadUser('', 'kid@example.org');
            const existing = { id: 3, clerkId: 'clerk_dev', email: 'Kid@Example.org', group: 'children' };
            mockPrisma.user.findFirst.mockResolvedValue(existing as never);
            mockPrisma.user.update.mockResolvedValue({ ...existing, clerkId: 'clerk_prod' } as never);

            const user = await provisionUser('clerk_prod', ' kid@example.org');

            expect(user).toMatchObject({ id: 3, clerkId: 'clerk_prod', group: 'children' });
            expect(mockPrisma.user.findFirst).toHaveBeenCalledWith({
                where: { email: { equals: 'kid@example.org', mode: 'insensitive' } },
                orderBy: { id: 'asc' },
            });
            expect(mockPrisma.user.update).toHaveBeenCalledWith({
                where: { id: 3 },
                data: { clerkId: 'clerk_prod' },
                include: { userGroup: true },
            });
            expect(mockPrisma.user.upsert).not.toHaveBeenCalled();
        });
    });
});
