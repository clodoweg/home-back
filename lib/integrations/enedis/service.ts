/**
 * Enedis Data Service
 * Provides methods to retrieve synchronized Enedis consumption and power data.
 */
import prisma from '../../prisma';
import { EnedisData } from './types';

/**
 * Retrieves Enedis consumption, max power, and load curve data.
 * Daily data and load curve use independent date ranges so callers can
 * fetch years of daily aggregates while keeping the load curve window small.
 *
 * @param start - Start date for daily consumption/max-power (defaults to Jan 1st of previous year).
 * @param end - End date for all data (defaults to today).
 * @param loadCurveStart - Start date for load curve only (defaults to 15 days ago).
 * @returns The series; daily data is capped to 3 years and the load curve to 31 days before `end`.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
/** WARNING: performance — the load curve has 48 points a day; client ranges are capped. */
const MAX_DAILY_RANGE_DAYS = 3 * 366;
const MAX_LOAD_CURVE_RANGE_DAYS = 31;

const latest = (a: Date, b: Date) => (a > b ? a : b);

export const getEnedisData = async (start?: Date, end?: Date, loadCurveStart?: Date): Promise<EnedisData> => {
    const endDate = end || new Date();

    // Day columns are @db.Date (midnight UTC): defaults are built in UTC, whatever the server zone.
    // Daily data: default to Jan 1st of the previous year for year-over-year comparison.
    const startDate = start || new Date(Date.UTC(endDate.getUTCFullYear() - 1, 0, 1));

    // Load curve: default to last 15 days — enough for the chart without bloating the payload.
    const requestedLoadCurveStart = loadCurveStart
        || new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate() - 15));

    // Ranges sent by the client are capped: an old start must not read years of load curve
    const dailyStart = latest(startDate, new Date(endDate.getTime() - MAX_DAILY_RANGE_DAYS * DAY_MS));
    const loadCurveStartDate = latest(requestedLoadCurveStart, new Date(endDate.getTime() - MAX_LOAD_CURVE_RANGE_DAYS * DAY_MS));

    const [dailyConsumption, dailyMaxPower, loadCurve] = await Promise.all([
        prisma.enedisDailyConsumption.findMany({
            where: { date: { gte: dailyStart, lte: endDate } },
            orderBy: { date: 'asc' }
        }),
        prisma.enedisDailyMaxPower.findMany({
            where: { date: { gte: dailyStart, lte: endDate } },
            orderBy: { date: 'asc' }
        }),
        prisma.enedisLoadCurve.findMany({
            where: { date: { gte: loadCurveStartDate, lte: endDate } },
            orderBy: { date: 'asc' }
        })
    ]);

    return { dailyConsumption, dailyMaxPower, loadCurve };
};
