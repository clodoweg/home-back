/**
 * Suez Water Integration Types
 * Data structures for daily water consumption and price metrics.
 */

/**
 * Represents a single daily water consumption record.
 */
export interface SuezDailyConsumption {
    /** The date of consumption */
    date: Date;
    /** The volume of water consumed on this day in Liters (L) */
    value: number;
    /** Whether this value is an estimate (e.g. backfilled monthly average) */
    isEstimate: boolean;
}

/** Attributes of the Suez consumption sensor: liters per day, and per month for the history. */
export interface SuezAttributes {
    this_month_consumption?: Record<string, number>;
    previous_month_consumption?: Record<string, number>;
    history?: Record<string, number>;
}

/**
 * Standardized data returned by the Suez service.
 */
export interface SuezData {
    /** Historical daily consumption records ordered chronologically */
    dailyConsumption: SuezDailyConsumption[];
    /** The current water price in € per cubic meter (m³) */
    price: number;
}
