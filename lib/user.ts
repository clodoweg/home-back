/**
 * User Identity Service
 * Handles database operations for user profile retrieval and creation.
 */
import prisma from './prisma';
import type { Prisma } from '@/lib/generated/prisma/client';
import { logger } from './logger';

/** Authenticated user, with the group that carries its permissions. */
export type AuthUser = Prisma.UserGetPayload<{ include: { userGroup: true } }>;

// No fallback: without ADMIN_EMAILS, nobody is promoted to admin automatically
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);

if (ADMIN_EMAILS.length === 0) {
    logger.warn('ADMIN_EMAILS is empty: new users will never be provisioned as admin');
}

/** Groups created on first provisioning, with their default permissions. */
export const DEFAULT_GROUPS: Array<{ name: string; permissions: string[] }> = [
    { name: 'admin', permissions: ['remote', 'history', 'cameras', 'admin'] },
    { name: 'user', permissions: [] },
    { name: 'children', permissions: [] },
];

async function ensureUserGroupsExist(): Promise<void> {
    for (const g of DEFAULT_GROUPS) {
        const existing = await prisma.userGroup.findUnique({ where: { name: g.name } });
        if (!existing) {
            await prisma.userGroup.create({ data: g });
            continue;
        }
        const missing = g.permissions.filter(p => !existing.permissions.includes(p));
        if (missing.length > 0) {
            await prisma.userGroup.update({
                where: { name: g.name },
                data: { permissions: { set: [...new Set([...existing.permissions, ...missing])] } },
            });
        }
    }
}

/**
 * Retrieves a user by their Clerk ID with group info included.
 * 
 * @param clerkId - The unique Clerk ID.
 * @returns The User object or null if not found.
 */
export async function getUser(clerkId: string): Promise<AuthUser | null> {
    return await prisma.user.findUnique({
        where: { clerkId },
        include: { userGroup: true },
    });
}

/**
 * Retrieve user by Clerk ID, creating it on the fly if missing.
 * Updates the stored email when called again for an existing user (on a user-cache miss).
 * Admin group is granted when the email is listed in ADMIN_EMAILS.
 *
 * @param clerkId - The unique Clerk ID.
 * @param email - Current email from the Clerk session.
 * @returns The Prisma User with userGroup included.
 */
export async function getOrCreateUser(clerkId: string, email: string): Promise<AuthUser> {
    await ensureUserGroupsExist();

    const normalizedEmail = (email || `user-${clerkId}`).toLowerCase();
    const group = ADMIN_EMAILS.includes(normalizedEmail) ? 'admin' : 'user';

    return await prisma.user.upsert({
        where: { clerkId },
        update: { email },
        create: {
            clerkId,
            email,
            group,
            widgetPreferences: {},
        },
        include: { userGroup: true },
    });
}
