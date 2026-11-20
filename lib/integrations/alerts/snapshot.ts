/**
 * Persist the last-seen state snapshot in SystemState so transitions survive
 * serverless cold starts. One row per snapshot key.
 */
import prisma from '@/lib/prisma';
import type { AlertSnapshot } from './types';

const KEY = 'alerts:lastSnapshot';

export async function loadSnapshot(): Promise<AlertSnapshot> {
    const row = await prisma.systemState.findUnique({ where: { key: KEY } });
    if (!row) return {};
    try {
        return JSON.parse(row.value) as AlertSnapshot;
    } catch {
        return {};
    }
}

export async function saveSnapshot(snapshot: AlertSnapshot): Promise<void> {
    const value = JSON.stringify(snapshot);
    await prisma.systemState.upsert({
        where: { key: KEY },
        update: { value },
        create: { key: KEY, value },
    });
}
