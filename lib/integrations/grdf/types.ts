/**
 * GRDF Integration Types
 * Data structures for gas consumption and temperature metrics.
 */
/** One period of the sensor.gazpar attributes (day "DD/MM/YYYY", week "Du … au …" or month). */
export interface GazparPeriod {
    time_period?: string;
    energy_kwh?: string | number;
    temperature_degC?: string | number;
}

/** Attributes of sensor.gazpar used by the mapper. */
export interface GazparAttributes {
    daily?: GazparPeriod[];
    monthly?: GazparPeriod[];
}

export interface GrdfDailyConsumption {
    date: Date;
    value: number;
    temp?: number;
    isEstimate: boolean;
}
