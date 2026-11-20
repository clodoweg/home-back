/**
 * Enedis Integration Types
 * Data structures for consumption, power, and load curve metrics.
 */
export interface DailyConsumption {
    date: Date;
    value: number;
}

export interface DailyMaxPower {
    date: Date;
    value: number;
}

export interface LoadCurve {
    date: Date;
    value: number;
}

export interface EnedisData {
    dailyConsumption: DailyConsumption[];
    dailyMaxPower: DailyMaxPower[];
    loadCurve: LoadCurve[];
}

export interface SyncResult {
    success: boolean;
    error?: string;
}
