/**
 * User Identity Service
 * Handles database operations for user profile retrieval and creation.
 */
import prisma from './prisma';
import type { Prisma } from '@/lib/generated/prisma/client';
import { logger } from './logger';

/** Authenticated user, with the group that carries its permissions. */
export type AuthUser = Prisma.UserGetPayload<{ include: { userGroup: true } }>;

/** Comma-separated emails of an environment variable, trimmed and lowercased. */
const parseEmailList = (raw: string | undefined): string[] =>
    (raw || '')
        .split(',')
        .map(e => e.trim().toLowerCase())
        .filter(Boolean);

// No fallback: without ADMIN_EMAILS, nobody is promoted to admin automatically
const ADMIN_EMAILS = parseEmailList(process.env.ADMIN_EMAILS);

// WARNING: Clerk sign-up may be open (and its allowlist is a paid feature on a production instance):
// this list, with ADMIN_EMAILS, is what keeps a stranger's Clerk account out of the database (audit H1)
const ALLOWED_EMAILS = parseEmailList(process.env.ALLOWED_EMAILS);

if (ADMIN_EMAILS.length === 0) {
    logger.warn('ADMIN_EMAILS is empty: new users will never be provisioned as admin');
}

/**
 * Whether a Clerk account with this email may get a database user. Existing users are not
 * concerned: only the creation of an account (or its re-attachment) checks it.
 *
 * @param email - Verified email address of the Clerk account.
 * @returns true when the email is listed in ALLOWED_EMAILS or ADMIN_EMAILS.
 */
export function canProvisionEmail(email: string): boolean {
    const normalizedEmail = email.trim().toLowerCase();
    return normalizedEmail !== '' && (ALLOWED_EMAILS.includes(normalizedEmail) || ADMIN_EMAILS.includes(normalizedEmail));
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
 * Retrieve user by Clerk ID, creating it on the fly if missing. Called by `provisionUser`, after
 * the allowlist check.
 * Updates the stored email when called again for an existing user.
 * Admin group is granted when the email is listed in ADMIN_EMAILS.
 *
 * @param clerkId - The unique Clerk ID.
 * @param email - Verified email of the Clerk account.
 * @returns The Prisma User with userGroup included.
 */
export async function getOrCreateUser(clerkId: string, email: string): Promise<AuthUser> {
    await ensureUserGroupsExist();

    const group = ADMIN_EMAILS.includes(email.trim().toLowerCase()) ? 'admin' : 'user';

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

/**
 * Gives a database user to a Clerk account seen for the first time, if its email is allowed.
 * A user already holding this email is re-attached to the new Clerk id, with its group, preferences,
 * Telegram chat and notifications: Clerk ids change when the accounts move to another instance
 * (development to production), and a person deleting then re-creating their account gets a new id.
 *
 * WARNING: `verifiedEmail` must come from Clerk with a verified status. The re-attachment trusts it
 * the way the admin promotion does: whoever proves this email owns the matching row.
 *
 * @param clerkId - Clerk id with no database user yet.
 * @param verifiedEmail - Verified primary email of the Clerk account.
 * @returns The user, or null when the email is not allowed (nothing is written then).
 */
export async function provisionUser(clerkId: string, verifiedEmail: string): Promise<AuthUser | null> {
    if (!canProvisionEmail(verifiedEmail)) return null;

    const existing = await prisma.user.findFirst({
        where: { email: { equals: verifiedEmail.trim(), mode: 'insensitive' } },
        orderBy: { id: 'asc' },
    });
    if (existing) {
        logger.info('Re-attached an existing user to a new Clerk id', { userId: clerkId, previousClerkId: existing.clerkId, email: existing.email });
        return await prisma.user.update({
            where: { id: existing.id },
            data: { clerkId },
            include: { userGroup: true },
        });
    }

    return await getOrCreateUser(clerkId, verifiedEmail);
}
