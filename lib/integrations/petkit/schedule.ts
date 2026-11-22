/** Petkit schedule — lecture du planning brut du distributeur (format ID,H,M,QTÉ,BAC répété) */

/**
 * Splits a meal amount between the two hoppers.
 * Bac selector: 0 = hopper 1 only, 1 = hopper 2 only, anything else (6…) = both, using the
 * programmed ratio.
 *
 * @param amount Total portions of the meal.
 * @param bacSelector Hopper selector from the raw schedule.
 * @param ratio1 Share of hopper 1 when both hoppers are used.
 * @returns Portions for each hopper.
 */
export function splitMealAmount(amount: number, bacSelector: number, ratio1: number): { amount1: number; amount2: number } {
    if (bacSelector === 0) return { amount1: amount, amount2: 0 };
    if (bacSelector === 1) return { amount1: 0, amount2: amount };
    const amount1 = Math.round(amount * ratio1);
    return { amount1, amount2: amount - amount1 };
}

/**
 * Parses the raw schedule sensor into meals. Groups of 5 values: id, hour, minute, amount,
 * bac selector. Meals without a positive amount are skipped.
 *
 * @param raw Raw sensor state.
 * @returns Meals with Paris hour/minute and their id.
 */
export function parseScheduleEntries(raw: string): Array<{ id: number; hour: number; minute: number; amount: number; bac: number }> {
    const parts = raw.split(',').map(p => parseInt(p.trim()));
    const entries = [];
    for (let i = 0; i + 4 < parts.length; i += 5) {
        const amount = parts[i + 3];
        if (isNaN(amount) || amount <= 0) continue;
        entries.push({ id: parts[i], hour: parts[i + 1], minute: parts[i + 2], amount, bac: parts[i + 4] });
    }
    return entries;
}

/**
 * Parses the raw schedule string from HA (format: ID,H,M,QTÉ,BAC,...) into the feeder
 * schedule shape expected by the front. Unlike parseScheduleEntries, zero amounts are kept.
 *
 * @param raw Raw sensor state.
 * @param ratio1 Share of hopper 1 for meals using both hoppers.
 * @param _ratio2 Unused, kept for the existing call signature.
 * @returns The schedule items and the planned total per hopper.
 */
export function parseRawSchedule(raw: string, ratio1: number = 1, _ratio2: number = 0) {
    if (!raw || typeof raw !== 'string') return { scheduleItems: [], planAmountTotal1: 0, planAmountTotal2: 0 };
    const parts = raw.split(',').map(p => parseInt(p.trim()));
    const items: Array<{ time: number; amount1: number; amount2: number; bac: number }> = [];
    let planAmountTotal1 = 0;
    let planAmountTotal2 = 0;
    for (let i = 0; i + 4 < parts.length; i += 5) {
        const h = parts[i + 1];
        const m = parts[i + 2];
        const bacSelector = parts[i + 4];
        const { amount1, amount2 } = splitMealAmount(parts[i + 3], bacSelector, ratio1);

        planAmountTotal1 += amount1;
        planAmountTotal2 += amount2;
        items.push({ time: h * 3600 + m * 60, amount1, amount2, bac: bacSelector });
    }
    const scheduleItems = [{ repeats: 127, suspended: false, items: items.toSorted((a, b) => a.time - b.time) }];
    return { scheduleItems, planAmountTotal1, planAmountTotal2 };
}
