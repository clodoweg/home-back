/**
 * Mock Clerk auth helpers.
 * Call these in test setup to simulate different auth states.
 */
import { vi } from 'vitest';
import { auth, verifyToken } from '@clerk/nextjs/server';
import { ADMIN_USER, STANDARD_USER, CHILDREN_USER } from './test-users';

import { mockPrisma } from '../setup';

const mockAuth = vi.mocked(auth);
const mockVerifyToken = vi.mocked(verifyToken);

/** Simulate an authenticated admin user */
export function mockAsAdmin() {
    mockAuth.mockResolvedValue({
        userId: ADMIN_USER.clerkId,
        sessionClaims: { email: ADMIN_USER.email },
    } as any);

    // Also mock the DB user lookup
    mockPrisma.user.findUnique.mockResolvedValue(ADMIN_USER as any);
}

/** Simulate an authenticated standard user */
export function mockAsUser() {
    mockAuth.mockResolvedValue({
        userId: STANDARD_USER.clerkId,
        sessionClaims: { email: STANDARD_USER.email },
    } as any);

    mockPrisma.user.findUnique.mockResolvedValue(STANDARD_USER as any);
}

/** Simulate an authenticated children user */
export function mockAsChildren() {
    mockAuth.mockResolvedValue({
        userId: CHILDREN_USER.clerkId,
        sessionClaims: { email: CHILDREN_USER.email },
    } as any);

    mockPrisma.user.findUnique.mockResolvedValue(CHILDREN_USER as any);
}

/** Simulate no authentication (anonymous request) */
export function mockAsUnauthenticated() {
    mockAuth.mockResolvedValue({ userId: null, sessionClaims: null } as any);
}

/** Simulate a valid Bearer token (for manual verification fallback) */
export function mockBearerToken(clerkId: string, email: string) {
    mockAuth.mockResolvedValue({ userId: null, sessionClaims: null } as any);
    mockVerifyToken.mockResolvedValue({ sub: clerkId, email } as any);
}
