/** Petkit types — contrats des données Petkit synthétisées depuis Home Assistant */

import type { HAState } from '@/lib/haClient';

/** Home Assistant state, as returned by /api/states and /api/history. */
export type HAEntityState = HAState;

/** Feeder or fountain event shown in the front timeline. */
export interface PetkitRecord {
    deviceId: number;
    deviceType: string;
    time: number;
    day: number;
    /** 1 movement, 2 visit, 3 meal, 4 distribution. */
    type: number;
    content: string;
    amount1?: number;
    amount2?: number;
    preview?: string;
    preview1?: string;
    preview2?: string;
    // Extra synthesis metadata (sources, isCounter, resId) kept as-is in the payload
    [key: string]: unknown;
}

/** Scheduled meal parsed from the raw distribution sensor. */
export interface ScheduledMeal {
    time: number;
    amount1: number;
    amount2: number;
    bac: number;
}

/** Fountain drink detected from the occupancy or counter sensors. */
export interface FountainWorkRecord {
    time: number;
    dayTime: number;
    stayTime: number;
}

/** Daily totals of the feeder (portions per hopper). */
export interface FeederDailyFeed {
    realAmountTotal1: number;
    realAmountTotal2: number;
    planAmountTotal1: number;
    planAmountTotal2: number;
    planRealAmountTotal1: number;
    planRealAmountTotal2: number;
    addAmountTotal1: number;
    addAmountTotal2: number;
    times: number;
    eatCount: number;
    eatAvg: number;
    eatTimes: number[];
}

/** Feeder device, in the shape the front widgets expect from the former Petkit API. */
export interface FeederDevice {
    id: number;
    deviceId: number;
    deviceType: string;
    name: string;
    status: {
        pim: number;
        food1: number;
        food2: number;
        batteryPower: number;
        batteryStatus: number;
        wifi: { rsq: number };
        feedSchedule: Array<{ repeats: number; suspended: boolean; items: Array<{ time: number; amount1: number; amount2: number; bac: number }> }>;
    };
    dailyFeed: FeederDailyFeed;
}

/** Fountain device. */
export interface FountainDevice {
    id: number;
    deviceId: number;
    deviceType: string;
    name: string;
    status: { powerStatus: number; runStatus: number; electricStatus: number; battery: number; pim: number; waterLevel: number };
    data: { status: { electricStatus: number; water_level_status: number } };
}

/** Fountain activity summary for one day. */
export interface FountainDay {
    deviceId: number;
    day: string;
    data: {
        filterPercent: number;
        lackWarning: boolean;
        mode: number;
        activity: { morning: number; afternoon: number; night: number };
        electricity: { batteryPercent: number; powerStatus: number };
    };
    workRecords: FountainWorkRecord[];
}

/** Payload of GET /api/petkit. */
export interface PetkitData {
    devices: Array<FeederDevice | FountainDevice>;
    records: PetkitRecord[];
    fountains: FountainDay[];
    lastSyncedAt: string;
    historyHealth?: { ok: boolean; status: number };
}
