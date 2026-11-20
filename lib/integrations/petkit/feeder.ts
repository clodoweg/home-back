/**
 * Petkit feeder — synthèse des repas, distributions et passages du distributeur D4sh.
 * Several Home Assistant sources describe the same distribution (raw schedule, hopper
 * counters, camera images): they are merged per 5-minute window, then completed with bowl
 * snapshots and, when history yields nothing, rebuilt from the schedule.
 */
import { getParisClock, getParisDate, getParisDayInt, getStableTimestamp, parseParisTimestamp } from '@/lib/paris-time';
import { parseRawSchedule, parseScheduleEntries, splitMealAmount } from './schedule';
import type { FeederDailyFeed, FeederDevice, HAEntityState, PetkitRecord, ScheduledMeal } from './types';

export const FEEDER_ENTITIES = {
    mealImage: 'image.croquettes_dernier_repas',
    distributionImage: 'image.croquettes_derniere_distribution',
    visitImage: 'image.croquettes_derniere_visite',
    movementImage: 'image.croquettes_dernier_mouvement',
    dishBeforeImage: 'image.croquettes_dish_before',
    dishAfterImage: 'image.croquettes_dish_after',
    counter1: 'sensor.croquettes_total_distribue_reservoir_1',
    counter2: 'sensor.croquettes_total_distribue_reservoir_2',
    rawSchedule: 'sensor.croquettes_donnees_brutes_de_distribution',
} as const;

const DEVICE = { deviceId: 1, deviceType: 'D4sh' } as const;
const DISTRIBUTION = 4;
const MEAL = 3;
const VISIT = 2;
const MOVEMENT = 1;
const DISH_BEFORE = 6;
const DISH_AFTER = 7;

const isUsableState = (state: string | undefined): state is string =>
    !!state && state !== 'unknown' && state !== 'unavailable';

/**
 * Builds the proxied URL of a Petkit snapshot stored by HA under
 * media/<device>/<yyyyMMdd Paris>/<category>/snapshot/<device>_<timestamp>.jpg.
 *
 * @param time Unix timestamp of the snapshot.
 * @param type Event type (1 movement … 7 dish after).
 * @returns The /api/ha/media URL, or '' for an unknown type or without PETKIT_DEVICE_ID.
 */
export function getHAMediaProxyUrl(time: number, type: number): string {
    const categories: Record<number, string> = {
        [MOVEMENT]: 'snapshot',
        [VISIT]: 'pet',
        [MEAL]: 'eat',
        [DISTRIBUTION]: 'feed',
        5: 'feed',
        [DISH_BEFORE]: 'dish_before',
        [DISH_AFTER]: 'dish_after',
    };
    const category = categories[type];
    // WHY: the device id is a personal identifier kept out of the (public) repository.
    const deviceId = (process.env.PETKIT_DEVICE_ID || '').trim();
    if (!category || !deviceId) return '';

    const dateStr = getParisDayInt(new Date(time * 1000)).toString();
    const mediaContentId = `media-source://local/media/${deviceId}/${dateStr}/${category}/snapshot/${deviceId}_${time}.jpg`;
    return `/api/ha/media?media_content_id=${encodeURIComponent(mediaContentId)}`;
}

/**
 * Finds the snapshot of an image entity taken closest to an instant, within 10 minutes.
 *
 * @param history History of the image entity (state = capture time in Paris).
 * @param targetTime Unix timestamp to match.
 * @param type Event type used to build the media URL.
 * @returns The media URL, or undefined when nothing is close enough.
 */
export function findClosestImage(history: HAEntityState[], targetTime: number, type: number): string | undefined {
    const found = history
        .filter(e => Math.abs(parseParisTimestamp(e.state) - targetTime) < 600)
        .sort((a, b) =>
            Math.abs(parseParisTimestamp(a.state) - targetTime) - Math.abs(parseParisTimestamp(b.state) - targetTime))[0];

    return found ? getHAMediaProxyUrl(parseParisTimestamp(found.state), type) : undefined;
}

interface DistributionExtra {
    isCounter?: boolean;
    resId?: number;
    preview1?: string;
    preview2?: string;
}

/**
 * Merges distributions coming from several sources into one record per 5-minute window.
 * Counters are trusted for amounts, the schedule history for labels.
 */
function createDistributionMerger() {
    const byWindow = new Map<string, PetkitRecord & { sources: Set<string> }>();

    const add = (time: number, amount1: number, amount2: number, label: string, preview?: string, extra?: DistributionExtra) => {
        const date = new Date(time * 1000);
        const dayInt = getParisDayInt(date);
        const { hour, minute } = getParisClock(date);
        const windowKey = `${dayInt}_${Math.floor((hour * 60 + minute) / 5)}`;
        const existing = byWindow.get(windowKey);
        const isFromCounter = !!extra?.isCounter;

        if (!existing || existing.type !== DISTRIBUTION) {
            byWindow.set(windowKey, {
                ...DEVICE,
                time,
                day: dayInt,
                type: DISTRIBUTION,
                content: label,
                amount1,
                amount2,
                preview,
                sources: new Set([isFromCounter ? 'counter' : 'history']),
                ...extra,
            });
            return;
        }

        if (preview && !existing.preview) existing.preview = preview;

        if (isFromCounter) {
            // A counter update only knows its own hopper
            if (extra?.resId === 1) {
                existing.amount1 = amount1;
            } else if (extra?.resId === 2) {
                existing.amount2 = amount2;
            } else {
                if (amount1 > 0) existing.amount1 = amount1;
                if (amount2 > 0) existing.amount2 = amount2;
            }
            existing.sources.add('counter');
        } else {
            if (!existing.sources.has('counter')) {
                existing.amount1 = amount1;
                existing.amount2 = amount2;
            }
            existing.sources.add('history');
        }

        if (extra?.preview1) existing.preview1 = extra.preview1;
        if (extra?.preview2) existing.preview2 = extra.preview2;
    };

    return { add, records: () => Array.from(byWindow.values()) };
}

type DistributionMerger = ReturnType<typeof createDistributionMerger>;

/**
 * Pass 1: scheduled meals from the raw distribution sensor history, once per meal id and day.
 * A meal is placed on the Paris day of the sensor update, and only counts once its time has
 * passed: the schedule also lists the meals still to come today.
 */
function addScheduledDistributions(merger: DistributionMerger, rawScheduleHistory: HAEntityState[], ratio1: number, nowSec: number) {
    const processedMealIds = new Set<string>();

    for (const entry of rawScheduleHistory) {
        if (!isUsableState(entry.state)) continue;
        const { year, month, day } = getParisDate(new Date(entry.last_changed as string));

        for (const meal of parseScheduleEntries(entry.state)) {
            const time = getStableTimestamp(year, month, day, meal.hour, meal.minute);
            if (time > nowSec) continue;
            const recordKey = `${getParisDayInt(new Date(time * 1000))}_${meal.id}`;
            if (processedMealIds.has(recordKey)) continue;
            processedMealIds.add(recordKey);

            const { amount1, amount2 } = splitMealAmount(meal.amount, meal.bac, ratio1);
            merger.add(time, amount1, amount2, 'Distribution programmée');
        }
    }
}

/**
 * Pass 2: real amounts from the "total distribué" counter increments of each hopper.
 */
function addCounterDistributions(merger: DistributionMerger, counters: Array<{ history: HAEntityState[]; resId: 1 | 2 }>) {
    for (const { history, resId } of counters) {
        let lastValue = -1;
        for (const entry of history) {
            const value = parseFloat(entry.state);
            if (isNaN(value)) continue;
            if (lastValue !== -1 && value > lastValue) {
                const time = Math.floor(new Date(entry.last_changed as string).getTime() / 1000);
                const amount = value - lastValue;
                merger.add(time, resId === 1 ? amount : 0, resId === 2 ? amount : 0, 'Distribution', undefined, { isCounter: true, resId });
            }
            lastValue = value;
        }
    }
}

/**
 * Pass 3: events from the camera image entities (meals, visits, movements, distributions).
 *
 * @returns The non-distribution records; distributions go to the merger.
 */
function collectImageEvents(
    merger: DistributionMerger,
    imageHistories: HAEntityState[][],
    dishBefore: HAEntityState[],
    dishAfter: HAEntityState[],
): PetkitRecord[] {
    const records: PetkitRecord[] = [];

    for (const history of imageHistories) {
        for (const entry of history) {
            if (!isUsableState(entry.state)) continue;
            const isMeal = entry.entity_id === FEEDER_ENTITIES.mealImage;
            const isDist = entry.entity_id === FEEDER_ENTITIES.distributionImage;
            const isVisit = entry.entity_id === FEEDER_ENTITIES.visitImage;
            const isMove = entry.entity_id === FEEDER_ENTITIES.movementImage;

            const time = parseParisTimestamp(entry.state);
            const mediaType = isMove ? MOVEMENT : isVisit ? VISIT : isMeal ? MEAL : DISTRIBUTION;
            const preview = getHAMediaProxyUrl(time, mediaType) || `/api/ha/image/${entry.entity_id}`;

            if (isDist) {
                merger.add(time, 0, 0, 'Distribution', preview, {
                    preview1: findClosestImage(dishBefore, time, DISH_BEFORE),
                    preview2: findClosestImage(dishAfter, time, DISH_AFTER),
                });
                continue;
            }

            const extra = isMeal
                ? { preview1: findClosestImage(dishBefore, time, DISH_BEFORE), preview2: findClosestImage(dishAfter, time, DISH_AFTER) }
                : {};
            records.push({
                ...DEVICE,
                time,
                day: getParisDayInt(new Date(time * 1000)),
                type: isVisit ? VISIT : isMove ? MOVEMENT : MEAL,
                content: isVisit ? 'Passage animal' : isMove ? 'Mouvement détecté' : 'Repas',
                preview,
                ...extra,
            });
        }
    }
    return records;
}

/**
 * Adds the events of the current image states, which history may not contain yet.
 * Without history access, no preview is exposed.
 */
function addCurrentImageEvents(
    merger: DistributionMerger,
    records: PetkitRecord[],
    states: HAEntityState[],
    hasHistoryAccess: boolean,
) {
    const findState = (id: string) => states.find(s => s.entity_id === id);
    const currentImages = [
        { img: findState(FEEDER_ENTITIES.mealImage), type: MEAL, label: 'Repas' },
        { img: findState(FEEDER_ENTITIES.distributionImage), type: DISTRIBUTION, label: 'Distribution' },
        { img: findState(FEEDER_ENTITIES.visitImage), type: VISIT, label: 'Passage animal' },
    ];

    for (const { img, type, label } of currentImages) {
        if (!img || !isUsableState(img.state)) continue;
        const time = parseParisTimestamp(img.state);
        const preview = hasHistoryAccess ? `/api/ha/image/${img.entity_id}` : undefined;

        if (type === DISTRIBUTION) {
            merger.add(time, 0, 0, label, preview);
        } else if (!records.some(r => Math.abs(r.time - time) < 300 && r.type === type)) {
            records.push({ ...DEVICE, time, day: getParisDayInt(new Date(time * 1000)), type, content: label, preview });
        }
    }
}

/**
 * Pass 4: bowl before/after snapshots for distributions and meals; the bowl-after photo
 * becomes the main preview when none exists.
 */
function attachBowlPreviews(distributions: PetkitRecord[], records: PetkitRecord[], dishBefore: HAEntityState[], dishAfter: HAEntityState[]) {
    for (const dist of distributions) {
        if (!dist.preview1) dist.preview1 = findClosestImage(dishBefore, dist.time, DISH_BEFORE);
        if (!dist.preview2) dist.preview2 = findClosestImage(dishAfter, dist.time, DISH_AFTER);
        if (!dist.preview && dist.preview2) dist.preview = dist.preview2;
    }

    for (const rec of records) {
        if (rec.type !== MEAL) continue;
        if (!rec.preview1) rec.preview1 = findClosestImage(dishBefore, rec.time, DISH_BEFORE);
        if (!rec.preview2) rec.preview2 = findClosestImage(dishAfter, rec.time, DISH_AFTER);
        rec.preview = rec.preview || rec.preview2;
    }
}

/**
 * Merges distributions and other events (one record per type and time), newest first.
 */
function mergeRecords(distributions: PetkitRecord[], records: PetkitRecord[]): PetkitRecord[] {
    const byKey = new Map<string, PetkitRecord>();
    for (const r of distributions) byKey.set(`${r.type}_${r.time}`, r);

    for (const r of records) {
        const key = `${r.type}_${r.time}`;
        const existing = byKey.get(key);
        if (!existing) {
            byKey.set(key, r);
            continue;
        }
        if (r.preview && !existing.preview) existing.preview = r.preview;
        if (r.preview1 && !existing.preview1) existing.preview1 = r.preview1;
        if (r.preview2 && !existing.preview2) existing.preview2 = r.preview2;
    }

    return Array.from(byKey.values()).sort((a, b) => b.time - a.time);
}

/**
 * Sums today's distributed portions per hopper.
 */
function sumDistributedToday(records: PetkitRecord[], todayInt: number): { distributed1: number; distributed2: number } {
    let distributed1 = 0;
    let distributed2 = 0;
    for (const r of records) {
        if (r.day === todayInt && (r.type === DISTRIBUTION || r.type === 5)) {
            distributed1 += r.amount1 || 0;
            distributed2 += r.amount2 || 0;
        }
    }
    return { distributed1, distributed2 };
}

/**
 * Fallback when history yields no distribution today: rebuilds the day's meals from the raw
 * schedule, scaled to the "total distribué" counters when present. Records are placed at each
 * scheduled time so the front's useFeederSchedule matches them to their slot; otherwise its
 * planned totals would desync from the distributed ones.
 *
 * @returns The distributed totals; `records` is updated in place.
 */
function synthesizeFromSchedule(
    records: PetkitRecord[],
    rawSchedule: string | undefined,
    ratio1: number,
    counter1Raw: string | undefined,
    counter2Raw: string | undefined,
    todayInt: number,
): { distributed1: number; distributed2: number } {
    const counter1 = counter1Raw ? parseFloat(counter1Raw) : NaN;
    const counter2 = counter2Raw ? parseFloat(counter2Raw) : NaN;
    const c1 = !isNaN(counter1) ? Math.round(counter1) : 0;
    const c2 = !isNaN(counter2) ? Math.round(counter2) : 0;
    const hasCounters = (!isNaN(counter1) || !isNaN(counter2)) && (c1 + c2) > 0;

    const meals: ScheduledMeal[] = [];
    let plannedA1 = 0;
    let plannedA2 = 0;
    const nowSec = Math.floor(Date.now() / 1000);
    const today = getParisDate(new Date());

    if (rawSchedule) {
        for (const entry of parseScheduleEntries(rawSchedule)) {
            const mealTime = getStableTimestamp(today.year, today.month, today.day, entry.hour || 0, entry.minute || 0);
            // Meals still to come today have not been distributed yet
            if (mealTime > nowSec) continue;
            const { amount1, amount2 } = splitMealAmount(entry.amount, entry.bac, ratio1);
            plannedA1 += amount1;
            plannedA2 += amount2;
            meals.push({ time: mealTime || nowSec, amount1, amount2, bac: entry.bac });
        }
    }

    let distributed1 = 0;
    let distributed2 = 0;

    if (hasCounters && meals.length > 0) {
        // Scale planned amounts so that their sum equals each hopper counter
        const scale = (planned: number, counter: number) => (planned > 0 ? counter / planned : 0);
        const s1 = scale(plannedA1, c1);
        const s2 = scale(plannedA2, c2);
        let acc1 = 0;
        let acc2 = 0;
        meals.forEach((meal, idx) => {
            if (idx === meals.length - 1) {
                // The last meal takes the remainder so that the sum is exact
                meal.amount1 = Math.max(0, c1 - acc1);
                meal.amount2 = Math.max(0, c2 - acc2);
            } else {
                meal.amount1 = Math.round(meal.amount1 * s1);
                meal.amount2 = Math.round(meal.amount2 * s2);
                acc1 += meal.amount1;
                acc2 += meal.amount2;
            }
        });
        distributed1 = c1;
        distributed2 = c2;
    } else if (meals.length > 0) {
        distributed1 = plannedA1;
        distributed2 = plannedA2;
    } else if (hasCounters) {
        // No schedule available: a single aggregate record
        distributed1 = c1;
        distributed2 = c2;
        records.push({ ...DEVICE, time: nowSec, day: todayInt, type: DISTRIBUTION, content: 'Distribution (total jour)', amount1: c1, amount2: c2 });
    }

    if (meals.length > 0 && distributed1 + distributed2 > 0) {
        for (let i = records.length - 1; i >= 0; i--) {
            const r = records[i];
            if (r.day === todayInt && (r.type === DISTRIBUTION || r.type === 5) && !r.amount1 && !r.amount2) {
                records.splice(i, 1);
            }
        }
        for (const meal of meals) {
            records.push({
                ...DEVICE,
                time: meal.time,
                day: todayInt,
                type: DISTRIBUTION,
                content: meal.bac === 2 ? 'Distribution manuelle' : 'Distribution',
                amount1: meal.amount1,
                amount2: meal.amount2,
            });
        }
        records.sort((a, b) => b.time - a.time);
    }

    return { distributed1, distributed2 };
}

/**
 * Builds the feeder device and its timeline from the current HA states and their history.
 *
 * @param states Current HA states.
 * @param history History per entity id (empty without history access or on HA failure).
 * @param hasHistoryAccess Whether previews of current images may be exposed.
 * @returns The feeder device payload and its records, newest first.
 */
export function buildFeeder(
    states: HAEntityState[],
    history: Map<string, HAEntityState[]>,
    hasHistoryAccess: boolean,
): { device: FeederDevice; records: PetkitRecord[] } {
    const getVal = (id: string) => states.find(s => s.entity_id === id)?.state;

    const batteryRaw = getVal('sensor.croquettes_niveau_de_batterie');
    const distTarget1 = parseFloat(getVal('sensor.croquettes_total_programme_reservoir_1') || '0');
    const distTarget2 = parseFloat(getVal('sensor.croquettes_total_programme_reservoir_2') || '0');
    const distTotal = distTarget1 + distTarget2;
    const ratio1 = distTotal > 0 ? distTarget1 / distTotal : 1;
    const ratio2 = distTotal > 0 ? distTarget2 / distTotal : 0;
    const rawSchedule = getVal(FEEDER_ENTITIES.rawSchedule);

    const dailyFeed: FeederDailyFeed = {
        realAmountTotal1: 0,
        realAmountTotal2: 0,
        // Programmed sensors rather than a sum of the history
        planAmountTotal1: distTarget1,
        planAmountTotal2: distTarget2,
        planRealAmountTotal1: 0,
        planRealAmountTotal2: 0,
        addAmountTotal1: 0,
        addAmountTotal2: 0,
        times: 0,
        eatCount: parseInt(getVal('sensor.croquettes_nombre_de_repas') || '0'),
        eatAvg: parseInt(getVal('sensor.croquettes_temps_moyen_de_repas') || '0'),
        eatTimes: [],
    };

    const device: FeederDevice = {
        id: 1,
        ...DEVICE,
        name: 'Croquettes',
        status: {
            pim: parseInt(getVal('sensor.croquettes_niveau_de_l_absorbeur_d_humidite') || '100'),
            food1: getVal('binary_sensor.croquettes_niveau_nourriture_reservoir_1') === 'on' ? 1 : 2,
            food2: getVal('binary_sensor.croquettes_niveau_nourriture_reservoir_2') === 'on' ? 1 : 2,
            batteryPower: batteryRaw && !isNaN(parseInt(batteryRaw)) ? parseInt(batteryRaw) : 100,
            batteryStatus: getVal('binary_sensor.croquettes_sur_batterie') === 'on' ? 0 : 1,
            wifi: { rsq: -50 },
            feedSchedule: parseRawSchedule(rawSchedule || '', ratio1, ratio2).scheduleItems,
        },
        dailyFeed,
    };

    const dishBefore = history.get(FEEDER_ENTITIES.dishBeforeImage) ?? [];
    const dishAfter = history.get(FEEDER_ENTITIES.dishAfterImage) ?? [];
    const imageHistories = [
        FEEDER_ENTITIES.mealImage,
        FEEDER_ENTITIES.distributionImage,
        FEEDER_ENTITIES.visitImage,
        FEEDER_ENTITIES.movementImage,
    ].flatMap(id => (history.has(id) ? [history.get(id)!] : []));

    const merger = createDistributionMerger();
    addScheduledDistributions(merger, history.get(FEEDER_ENTITIES.rawSchedule) ?? [], ratio1, Math.floor(Date.now() / 1000));
    addCounterDistributions(merger, [
        { history: history.get(FEEDER_ENTITIES.counter1) ?? [], resId: 1 },
        { history: history.get(FEEDER_ENTITIES.counter2) ?? [], resId: 2 },
    ]);
    const otherRecords = collectImageEvents(merger, imageHistories, dishBefore, dishAfter);
    addCurrentImageEvents(merger, otherRecords, states, hasHistoryAccess);

    const distributions = merger.records();
    attachBowlPreviews(distributions, otherRecords, dishBefore, dishAfter);
    const records = mergeRecords(distributions, otherRecords);

    const todayInt = getParisDayInt(new Date());
    let totals = sumDistributedToday(records, todayInt);
    if (totals.distributed1 === 0 && totals.distributed2 === 0) {
        totals = synthesizeFromSchedule(
            records,
            rawSchedule,
            ratio1,
            getVal(FEEDER_ENTITIES.counter1),
            getVal(FEEDER_ENTITIES.counter2),
            todayInt,
        );
    }

    dailyFeed.realAmountTotal1 = totals.distributed1;
    dailyFeed.realAmountTotal2 = totals.distributed2;

    return { device, records };
}
