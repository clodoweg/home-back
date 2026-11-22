/**
 * Daily usage service — calcule chaque nuit les compteurs d'usage des jours écoulés (heures
 * d'allumage, cycles, détections, repas, alertes) et les garde en base, au-delà des 10 jours
 * d'historique que Home Assistant conserve ; puis les relit pour l'onglet Historique du front.
 */
import { getCachedStates } from '@/lib/ha-states-cache';
import { haFetch } from '@/lib/haClient';
import { logger } from '@/lib/logger';
import { getParisDate, getParisDayString, getStableTimestamp } from '@/lib/paris-time';
import prisma from '@/lib/prisma';
import { computeUsage, type TimedState } from './compute';
import { buildUsageRules } from './rules';

const DAY_MS = 24 * 60 * 60 * 1000;
const LAST_DAY_KEY = 'dailyUsage.lastDay';

/**
 * WARNING: HA purges its history after 10 days by default: older days can no longer be
 * computed, so a missed run is caught up within this limit only.
 */
export const MAX_CATCH_UP_DAYS = 9;

/** History points as HA returns them with `minimal_response` (the first one is complete). */
interface RawPoint {
    entity_id?: string;
    state: string;
    attributes?: Record<string, unknown>;
    last_changed?: string;
    last_updated?: string;
}

/** A Paris day: `yyyy-MM-dd`, start and end instants. */
interface ParisDay {
    day: string;
    from: number;
    to: number;
}

/**
 * Bounds of the Paris day containing `date`, DST included (23 or 25 hours).
 *
 * @param day - Day as `yyyy-MM-dd`.
 * @returns The day and its bounds in milliseconds.
 */
export function parisDayBounds(day: string): ParisDay {
    const [year, month, date] = day.split('-').map(Number);
    const from = getStableTimestamp(year, month - 1, date, 0, 0) * 1000;
    const next = getParisDate(new Date(from + DAY_MS + 3 * 60 * 60 * 1000));
    const to = getStableTimestamp(next.year, next.month, next.day, 0, 0) * 1000;
    return { day, from, to };
}

/**
 * Days to compute: the day after the last one done, up to yesterday, at most MAX_CATCH_UP_DAYS.
 *
 * @param lastDone - Last computed day (`yyyy-MM-dd`), or null before the first run.
 * @param now - Current instant.
 * @returns Days in chronological order (empty when yesterday is done).
 */
export function daysToCompute(lastDone: string | null, now: Date): ParisDay[] {
    const today = parisDayBounds(getParisDayString(now));
    const days: ParisDay[] = [];
    let cursor = today.from;
    for (let i = 0; i < MAX_CATCH_UP_DAYS; i++) {
        const day = getParisDayString(new Date(cursor - 12 * 60 * 60 * 1000));
        if (lastDone && day <= lastDone) break;
        const bounds = parisDayBounds(day);
        days.unshift(bounds);
        cursor = bounds.from;
    }
    return days;
}

const toTimedStates = (series: RawPoint[]): TimedState[] =>
    series
        .map(point => ({
            state: point.state,
            at: new Date(point.last_changed ?? point.last_updated ?? '').getTime(),
            ...(point.attributes ? { attributes: point.attributes } : {}),
        }))
        .filter(point => Number.isFinite(point.at))
        .sort((a, b) => a.at - b.at);

/**
 * Fetches the history of the given entities over a span, keyed by entity id.
 *
 * @param entityIds - Entities to read.
 * @param from - Span start (ms).
 * @param to - Span end (ms).
 * @param withAttributes - Keep every point's attributes (heavier: only for the rules that read
 * them); otherwise the states alone.
 * @returns The points per entity, or null when HA fails.
 */
async function fetchHistory(
    entityIds: string[],
    from: number,
    to: number,
    withAttributes = false,
): Promise<Map<string, TimedState[]> | null> {
    const history = new Map<string, TimedState[]>();
    if (entityIds.length === 0) return history;
    const start = encodeURIComponent(new Date(from).toISOString());
    const query = new URLSearchParams({
        filter_entity_id: entityIds.join(','),
        end_time: new Date(to).toISOString(),
    });
    const flags = withAttributes ? '' : '&minimal_response&no_attributes';
    const { data, ok } = await haFetch<RawPoint[][]>(
        `/api/history/period/${start}?${query.toString()}${flags}`,
        { label: 'daily-usage-history' },
    );
    if (!ok || !Array.isArray(data)) return null;
    for (const series of data) {
        const entityId = Array.isArray(series) ? series[0]?.entity_id : undefined;
        if (entityId) history.set(entityId, toTimedStates(series));
    }
    return history;
}

/**
 * Alerts per category on a day. Each alert is stored once per admin: the same category, title
 * and instant (to the second) is one alert.
 */
async function countAlerts(day: ParisDay): Promise<Map<string, number>> {
    const notifications = await prisma.notification.findMany({
        where: { createdAt: { gte: new Date(day.from), lt: new Date(day.to) } },
        select: { category: true, title: true, createdAt: true },
    });
    const seen = new Set<string>();
    const counts = new Map<string, number>();
    for (const { category, title, createdAt } of notifications) {
        const key = `${category}|${title}|${Math.floor(createdAt.getTime() / 1000)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        counts.set(`alerts:${category}`, (counts.get(`alerts:${category}`) ?? 0) + 1);
    }
    return counts;
}

export interface DailyUsageSyncResult {
    days: string[];
    rows: number;
}

/**
 * WARNING: performance — days computed per run. Each day is one HA history call (10 s timeout)
 * and the alert check that runs the sync shares Vercel's 60 s with it: a backlog is caught up a
 * few days per run rather than in one call that could time out run after run.
 */
export const DAYS_PER_RUN = 3;

/**
 * Computes and stores the usage counters of the days not done yet (up to yesterday), oldest
 * first, a few days per run. Each day is saved with the marker as soon as it is computed.
 *
 * @param now - Current instant (tests).
 * @param maxDays - Days computed at most in this run.
 * @param redo - Recompute the last `maxDays` days up to yesterday, even those already done (after
 * a new counter or a corrected rule; HA's history only goes back 10 days).
 * @returns The days computed and the number of rows written.
 * @throws When HA or the database fails: the days saved before stay, the others are retried by
 * the next run. The message names the step that failed.
 */
export async function syncDailyUsage(now = new Date(), maxDays = DAYS_PER_RUN, redo = false): Promise<DailyUsageSyncResult> {
    const lastDone = redo ? null : await prisma.systemState.findUnique({ where: { key: LAST_DAY_KEY } });
    const pending = daysToCompute(lastDone?.value ?? null, now);
    const days = redo ? pending.slice(-maxDays) : pending.slice(0, maxDays);
    if (days.length === 0) return { days: [], rows: 0 };

    const states = await getCachedStates();
    if (!states.ok) throw new Error('HA states unavailable');
    const rules = buildUsageRules(states.data);
    const attributeIds = [...new Set(rules.filter(rule => rule.needsAttributes).map(rule => rule.entityId))];
    const stateIds = [...new Set(rules.map(rule => rule.entityId))].filter(id => !attributeIds.includes(id));

    const done: string[] = [];
    let rows = 0;
    for (const day of days) {
        const stateHistory = await fetchHistory(stateIds, day.from, day.to);
        const attributeHistory = await fetchHistory(attributeIds, day.from, day.to, true);
        if (!stateHistory || !attributeHistory) throw new Error(`HA history unavailable for ${day.day} (${done.length} day(s) saved before)`);
        const history = new Map([...stateHistory, ...attributeHistory]);

        const totals = new Map<string, number>();
        for (const rule of rules) {
            const points = history.get(rule.entityId);
            if (!points || points.length === 0) continue;
            const value = computeUsage(rule, points, day.from, day.to);
            // A mean with no reading in the day (spa off line) is no value, not zero.
            if (Number.isFinite(value)) totals.set(rule.metric, (totals.get(rule.metric) ?? 0) + value);
        }
        for (const [metric, value] of await countAlerts(day)) totals.set(metric, value);

        const date = new Date(`${day.day}T00:00:00Z`);
        // Three statements whatever the number of metrics: the transaction pooler serves them
        // on one connection, where hundreds of upserts took a round trip each.
        await prisma.$transaction([
            prisma.dailyUsage.deleteMany({ where: { date } }),
            prisma.dailyUsage.createMany({ data: [...totals].map(([metric, value]) => ({ date, metric, value })) }),
            prisma.systemState.upsert({
                where: { key: LAST_DAY_KEY },
                update: { value: day.day },
                create: { key: LAST_DAY_KEY, value: day.day },
            }),
        ]);
        done.push(day.day);
        rows += totals.size;
    }

    logger.info('[DailyUsage] Days computed', { days: done, rows });
    return { days: done, rows };
}

/**
 * Runs the sync when yesterday is not done yet, without ever throwing: the caller (the alert
 * check) must not fail because of it.
 *
 * @param now - Current instant (tests).
 * @returns The sync result, or null when nothing was due or it failed.
 */
export async function syncDailyUsageIfDue(now = new Date()): Promise<DailyUsageSyncResult | null> {
    try {
        const lastDone = await prisma.systemState.findUnique({ where: { key: LAST_DAY_KEY } });
        if (daysToCompute(lastDone?.value ?? null, now).length === 0) return null;
        return await syncDailyUsage(now);
    } catch (error) {
        logger.error('[DailyUsage] Sync failed', { error: String(error) });
        return null;
    }
}

/** Series of one metric: `date` as `yyyy-MM-dd`. */
export type UsageSeries = Record<string, { date: string; value: number }[]>;

/**
 * Stored usage counters over a range of days.
 *
 * @param start - First day (`yyyy-MM-dd`).
 * @param end - Last day (`yyyy-MM-dd`), included.
 * @param includeMetric - Filter on the metric name (rights).
 * @returns Series per metric, days in chronological order.
 */
export async function getDailyUsage(start: string, end: string, includeMetric: (metric: string) => boolean): Promise<UsageSeries> {
    const rows = await prisma.dailyUsage.findMany({
        where: { date: { gte: new Date(`${start}T00:00:00Z`), lte: new Date(`${end}T00:00:00Z`) } },
        orderBy: { date: 'asc' },
        select: { date: true, metric: true, value: true },
    });
    const series: UsageSeries = {};
    for (const { date, metric, value } of rows) {
        if (!includeMetric(metric)) continue;
        series[metric] ??= [];
        series[metric].push({ date: date.toISOString().slice(0, 10), value });
    }
    return series;
}
