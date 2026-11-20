/** Weather types — forecasts returned by the HA weather.get_forecasts service */

export type ForecastType = 'daily' | 'hourly';

/**
 * One forecast entry, relayed as HA sends it. `datetime` is always present; the other
 * fields depend on the weather integration.
 */
export interface WeatherForecastEntry {
    datetime: string;
    condition?: string;
    temperature?: number;
    templow?: number;
    precipitation?: number;
    precipitation_probability?: number;
    humidity?: number;
    wind_speed?: number;
    wind_bearing?: number | string;
    [key: string]: unknown;
}
