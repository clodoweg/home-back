/**
 * Enedis Data Synchronizer
 * Orchestrates API ingestion from Enedis and persistence in Prisma.
 */
import { Prisma } from '@/lib/generated/prisma/client';
import prisma from '../../prisma';
import { fetchDailyConsumption, fetchDailyMaxPower, fetchLoadCurve, formatDate } from './client';
import { SyncResult } from './types';
import { logger } from '@/lib/logger';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const API_DELAY_MS = 1000;

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Split a date range into consecutive chunks of `daysPerChunk` days. */
function getChunks(startDate: Date, endDate: Date, daysPerChunk: number) {
    const chunks: { start: Date; end: Date }[] = [];
    const chunkSizeMs = daysPerChunk * MS_PER_DAY;
    let currentStart = new Date(startDate);

    while (currentStart < endDate) {
        let currentEnd = new Date(currentStart.getTime() + chunkSizeMs);
        if (currentEnd > endDate) currentEnd = endDate;
        chunks.push({ start: new Date(currentStart), end: new Date(currentEnd) });
        currentStart = currentEnd;
    }
    return chunks;
}

type UpsertableModel = {
    upsert: (args: {
        where: { date: Date };
        update: { value: number };
        create: { date: Date; value: number };
    }) => Prisma.PrismaPromise<unknown>;
};

/** MyElectricalData payload: one reading per day or per 30-minute step. */
interface EnedisPayload {
    meter_reading?: { interval_reading?: Array<{ date: string; value: string }> };
}

/**
 * Sync a single Enedis time-series: fetch each chunk, upsert every reading
 * in one transaction per chunk, throttle between chunks.
 * Returns true on partial/total failure so callers can aggregate errors.
 */
async function syncTimeSeries(
    name: string,
    fetcher: (start: Date, end: Date) => Promise<EnedisPayload>,
    model: UpsertableModel,
    chunks: { start: Date; end: Date }[],
): Promise<boolean> {
    logger.debug(`[Enedis Sync] Syncing ${name}...`);
    let hasErrors = false;

    for (const [index, chunk] of chunks.entries()) {
        try {
            const payload = await fetcher(chunk.start, chunk.end);
            const readings = payload?.meter_reading?.interval_reading;
            if (Array.isArray(readings) && readings.length > 0) {
                await prisma.$transaction(
                    readings.map((reading): Prisma.PrismaPromise<unknown> => {
                        const date = new Date(reading.date);
                        const value = Math.round(parseFloat(reading.value));
                        return model.upsert({
                            where: { date },
                            update: { value },
                            create: { date, value },
                        });
                    }),
                );
            }
            if (index < chunks.length - 1) await delay(API_DELAY_MS);
        } catch (e) {
            logger.error(`[Enedis Sync] ${name} chunk ${formatDate(chunk.start)} failed`, { error: String(e) });
            hasErrors = true;
        }
    }
    return hasErrors;
}

/**
 * Synchronizes Enedis data for a specified number of days.
 *
 * @param daysBack - Number of days to look back.
 * @param includeLoadCurve - Whether to include detailed load curve data.
 * @returns Sync result with success status.
 */
export const syncEnedisData = async (
    daysBack: number = 7,
    includeLoadCurve: boolean = true,
): Promise<SyncResult> => {
    const end = new Date();
    const start = new Date(end.getTime() - daysBack * MS_PER_DAY);

    logger.debug(`[Enedis Sync] Synchronizing from ${formatDate(start)} to ${formatDate(end)}`);

    // Load curve is only available for the last 2 days via MyElectricalData
    const loadCurveStart = new Date(Math.max(start.getTime(), end.getTime() - 2 * MS_PER_DAY));

    const results = await Promise.all([
        syncTimeSeries('Daily Consumption', fetchDailyConsumption, prisma.enedisDailyConsumption, getChunks(start, end, 30)),
        syncTimeSeries('Daily Max Power', fetchDailyMaxPower, prisma.enedisDailyMaxPower, getChunks(start, end, 30)),
        includeLoadCurve
            ? syncTimeSeries('Load Curve', fetchLoadCurve, prisma.enedisLoadCurve, getChunks(loadCurveStart, end, 7))
            : Promise.resolve(false),
    ]);

    return { success: !results.some(Boolean) };
};
