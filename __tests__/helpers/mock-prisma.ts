/**
 * Mock PrismaClient for tests.
 * Uses vitest-mock-extended for deep mocking of all Prisma methods.
 */
import { mockDeep, mockReset, DeepMockProxy } from 'vitest-mock-extended';
import { PrismaClient } from '@/lib/generated/prisma/client';
import { beforeEach } from 'vitest';

export const mockPrisma = mockDeep<PrismaClient>();

// Reset all mocks between tests
beforeEach(() => {
    mockReset(mockPrisma);
});

export type MockPrisma = DeepMockProxy<PrismaClient>;
