/**
 * HA statistics — statistiques long terme du recorder Home Assistant (moyenne, min, max, cumul
 * par heure, jour, semaine ou mois), au-delà de la purge de l'historique (10 jours par défaut).
 */
import { z } from 'zod';
import { haWebSocketCommand } from '@/lib/ha-websocket';
import { entityIdPattern } from '@/lib/validators';

export const STATISTIC_PERIODS = ['hour', 'day', 'week', 'month'] as const;
export const STATISTIC_TYPES = ['mean', 'min', 'max', 'change', 'sum'] as const;

export type StatisticPeriod = (typeof STATISTIC_PERIODS)[number];
type StatisticType = (typeof STATISTIC_TYPES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_STATISTIC_IDS = 40;

/**
 * WARNING: performance — longest window per period, so that one call never asks HA for more
 * than ~1,000 rows per statistic (hours over a month, days over 13 months, weeks and months
 * over 6 years).
 */
const MAX_RANGE_DAYS: Record<StatisticPeriod, number> = {
    hour: 32,
    day: 400,
    week: 6 * 366,
    month: 6 * 366,
};

const commaList = (allowed?: readonly string[]) =>
    z
        .string()
        .max(4000)
        .transform(value => value.split(',').map(item => item.trim()).filter(Boolean))
        .pipe(
            allowed
                ? z.array(z.enum(allowed as [string, ...string[]])).min(1).max(allowed.length)
                : z.array(z.string().regex(entityIdPattern)).min(1).max(MAX_STATISTIC_IDS),
        );

/** Query of GET /api/ha/statistics. */
export const statisticsQuerySchema = z
    .object({
        statistic_ids: commaList(),
        start: z.iso.datetime({ offset: true }),
        end: z.iso.datetime({ offset: true }),
        period: z.enum(STATISTIC_PERIODS),
        types: commaList(STATISTIC_TYPES).optional(),
    })
    .refine(({ start, end }) => new Date(start) < new Date(end), { message: 'start must precede end', path: ['start'] })
    .refine(
        ({ start, end, period }) => new Date(end).getTime() - new Date(start).getTime() <= MAX_RANGE_DAYS[period] * DAY_MS,
        { message: 'Range too long for this period', path: ['end'] },
    );

export type StatisticsQuery = z.infer<typeof statisticsQuerySchema>;

/** One row of a statistic, `start` as an ISO instant. */
export interface StatisticRow {
    start: string;
    mean?: number | null;
    min?: number | null;
    max?: number | null;
    change?: number | null;
    sum?: number | null;
}

/** HA row: `start` in milliseconds since HA 2023.3, an ISO string before. */
interface HAStatisticRow extends Omit<StatisticRow, 'start'> {
    start: number | string;
}

const toIso = (start: number | string): string => new Date(start).toISOString();

/**
 * Reads long-term statistics from the HA recorder.
 *
 * @param query - Validated statistic ids, window, period and value types.
 * @returns Rows per statistic id (ids without statistics are absent), in chronological order.
 * @throws HAWebSocketError when HA cannot be reached or refuses the command.
 */
export async function getStatistics(query: StatisticsQuery): Promise<Record<string, StatisticRow[]>> {
    const types: StatisticType[] = (query.types as StatisticType[] | undefined) ?? ['mean', 'min', 'max', 'change'];
    const raw = await haWebSocketCommand<Record<string, HAStatisticRow[]>>(
        {
            type: 'recorder/statistics_during_period',
            start_time: new Date(query.start).toISOString(),
            end_time: new Date(query.end).toISOString(),
            statistic_ids: query.statistic_ids,
            period: query.period,
            types,
        },
        'statistics',
    );

    const result: Record<string, StatisticRow[]> = {};
    for (const [statisticId, rows] of Object.entries(raw ?? {})) {
        if (!Array.isArray(rows)) continue;
        result[statisticId] = rows.map(row => {
            const out: StatisticRow = { start: toIso(row.start) };
            for (const type of types) {
                if (row[type] !== undefined) out[type] = row[type];
            }
            return out;
        });
    }
    return result;
}
