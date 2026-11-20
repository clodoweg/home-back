/** Daily usage compute — valeur d'un compteur d'usage sur une fenêtre, à partir de l'historique HA. */
import type { UsageRule } from './rules';

/** One history point: state and the instant it started, in milliseconds. */
export interface TimedState {
    state: string;
    at: number;
    /** Only for the entities whose rule reads them (`needsAttributes`). */
    attributes?: Record<string, unknown>;
}

const UNKNOWN_STATES = new Set(['unavailable', 'unknown', '']);
const HOUR_MS = 60 * 60 * 1000;

/**
 * Value of a usage rule over `[from, to)`.
 *
 * @param rule - What to measure.
 * @param points - The entity's history in chronological order; the first point is the state at
 * (or before) the start of the fetched span.
 * @param from - Window start (ms).
 * @param to - Window end (ms); for today, the current instant.
 * @returns Hours for `duration`, a count for `entries` and `changes`, a rise for `increase`, the
 * time-weighted mean for `mean` (NaN when no value is known in the window).
 */
export function computeUsage(rule: UsageRule, points: TimedState[], from: number, to: number): number {
    if (rule.kind === 'mean') return timeWeightedMean(rule, points, from, to);
    const isActive = (point: TimedState) => (rule.isActive ? rule.isActive(point.state, point.attributes) : false);
    let total = 0;

    for (let i = 0; i < points.length; i++) {
        const point = points[i];
        const previous = points[i - 1];
        const inWindow = point.at >= from && point.at < to;

        if (rule.kind === 'duration') {
            if (!isActive(point)) continue;
            const end = Math.min(points[i + 1]?.at ?? to, to);
            const start = Math.max(point.at, from);
            if (end > start) total += end - start;
        } else if (!inWindow || !previous) {
            continue;
        } else if (rule.kind === 'entries') {
            if (isActive(point) && !isActive(previous)) total += 1;
        } else if (rule.kind === 'changes') {
            // An image entity's state is the time of its last picture: each new value is a new
            // picture. Going through `unavailable` and back is not one.
            if (UNKNOWN_STATES.has(point.state)) continue;
            const lastKnown = points.slice(0, i).reverse().find(p => !UNKNOWN_STATES.has(p.state));
            if (lastKnown && lastKnown.state !== point.state) total += 1;
        } else {
            const value = Number(point.state);
            const lastKnown = points.slice(0, i).reverse().find(p => Number.isFinite(Number(p.state)) && !UNKNOWN_STATES.has(p.state));
            if (!Number.isFinite(value) || UNKNOWN_STATES.has(point.state) || !lastKnown) continue;
            const before = Number(lastKnown.state);
            // A counter that went down was reset (daily counters reset at midnight): what it
            // shows now was counted since the reset.
            total += value >= before ? value - before : value;
        }
    }

    return rule.kind === 'duration' ? Math.round((total / HOUR_MS) * 100) / 100 : total;
}

/**
 * Mean of a value over `[from, to)`, each value weighted by how long it held: a temperature read
 * every few minutes in the evening does not outweigh a whole quiet afternoon.
 */
function timeWeightedMean(rule: UsageRule, points: TimedState[], from: number, to: number): number {
    let weighted = 0;
    let duration = 0;
    for (let i = 0; i < points.length; i++) {
        const value = rule.value?.(points[i]);
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        const start = Math.max(points[i].at, from);
        const end = Math.min(points[i + 1]?.at ?? to, to);
        if (end <= start) continue;
        weighted += value * (end - start);
        duration += end - start;
    }
    return duration === 0 ? Number.NaN : Math.round((weighted / duration) * 10) / 10;
}
