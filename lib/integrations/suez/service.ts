/**
 * Suez Water Data Service
 * Retrieves water consumption history and current unit price from Home Assistant.
 */

import { haGet, type HAState } from '../../haClient';
import type { SuezAttributes, SuezData, SuezDailyConsumption } from './types';
import { logger } from '@/lib/logger';

/** €/m³ used when the price sensor is unavailable (value reported by Suez in March 2026). */
const FALLBACK_WATER_PRICE = 2.74;

/**
 * Retrieves Suez water consumption and price statistics from Home Assistant.
 * Uses the rich historical attributes embedded inside the sensor's current state.
 * 
 * @param start - Optional start date (defaults to 3 years ago).
 * @param end - Optional end date (defaults to today).
 * @returns Standardized Suez data payload.
 */
export const getSuezData = async (start?: Date, end?: Date): Promise<SuezData> => {
    const endDate = end || new Date();
    const startDate = start || (() => {
        const d = new Date(endDate);
        d.setFullYear(d.getFullYear() - 3);
        d.setHours(0, 0, 0, 0);
        return d;
    })();

    // WHY: the HA Suez sensors are named after the counter number, a customer identifier kept out of
    // the (public) repository: it comes from SUEZ_COUNTER_ID. Without it, no Suez data at all.
    const counterId = (process.env.SUEZ_COUNTER_ID || '').trim();
    if (!counterId) {
        logger.warn('[Suez] SUEZ_COUNTER_ID is empty: no Suez data');
        return { dailyConsumption: [], price: FALLBACK_WATER_PRICE };
    }
    const priceEntity = `sensor.${counterId}_prix_de_l_eau`;
    const consumptionEntity = `sensor.${counterId}_consommation_d_eau_hier`;

    // 1. Fetch current price
    let price = FALLBACK_WATER_PRICE;
    try {
        const priceRes = await haGet<HAState>(`/api/states/${priceEntity}`);
        if (priceRes.ok && priceRes.data && priceRes.data.state) {
            const parsedPrice = parseFloat(priceRes.data.state);
            if (!isNaN(parsedPrice)) {
                price = parsedPrice;
            }
        } else {
            logger.warn(`[Suez] ${priceEntity} unavailable, using fallback ${FALLBACK_WATER_PRICE}`);
        }
    } catch (e) {
        logger.error('[Suez] Failed to fetch price from HA', { error: String(e) });
    }

    // 2. Fetch sensor state containing historical attributes
    let dailyConsumption: SuezDailyConsumption[] = [];
    try {
        let attributes: SuezAttributes | null = null;

        // Try getting current state and check if it has valid consumption/history attributes
        const sensorRes = await haGet<HAState>(`/api/states/${consumptionEntity}`);
        if (
            sensorRes.ok &&
            sensorRes.data &&
            sensorRes.data.state !== 'unavailable' &&
            sensorRes.data.attributes &&
            (sensorRes.data.attributes.this_month_consumption || sensorRes.data.attributes.history)
        ) {
            attributes = sensorRes.data.attributes as SuezAttributes;
        } else {
            // WHY: When the Suez integration fails to fetch from the portal (e.g. daily API limit or credentials),
            // Home Assistant sets the state to 'unavailable' and strips out custom attributes.
            // We search the history database for the most recent valid state payload to recover historical data.
            logger.warn(`[Suez] ${consumptionEntity} current state is unavailable or missing attributes, attempting history fallback...`);

            const startHistory = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
            const endHistory = new Date().toISOString();
            const historyUrl = `/api/history/period/${encodeURIComponent(startHistory)}?filter_entity_id=${encodeURIComponent(consumptionEntity)}&end_time=${encodeURIComponent(endHistory)}`;
            const historyRes = await haGet<HAState[][]>(historyUrl);

            if (historyRes.ok && historyRes.data && Array.isArray(historyRes.data[0])) {
                const statesList = historyRes.data[0];
                for (let i = statesList.length - 1; i >= 0; i--) {
                    const stateObj = statesList[i];
                    if (
                        stateObj &&
                        stateObj.state !== 'unavailable' &&
                        stateObj.attributes &&
                        (stateObj.attributes.this_month_consumption || stateObj.attributes.history)
                    ) {
                        attributes = stateObj.attributes as SuezAttributes;
                        logger.debug(`[Suez] Successfully recovered valid attributes from history state at index ${i} (updated ${stateObj.last_updated})`);
                        break;
                    }
                }
            }
        }

        if (attributes) {
            dailyConsumption = mapSuezAttributes(attributes, startDate, endDate);
        } else {
            logger.warn(`[Suez] ${consumptionEntity} has no valid attributes in current state or recent history`);
        }
    } catch (e) {
        logger.error('[Suez] Failed to fetch Suez state attributes from HA', { error: String(e) });
    }

    return { dailyConsumption, price };
};

/**
 * Pure mapping function to parse raw HA Suez sensor attributes into standardized consumption records.
 * Prioritizes daily actuals over monthly estimates, backfilling older months chronologically.
 * 
 * @param attributes - Raw Home Assistant sensor attributes (containing this_month_consumption, previous_month_consumption, history).
 * @param startDate - Filter start date.
 * @param endDate - Filter end date.
 * @returns Sorted daily consumption records array.
 */
export const mapSuezAttributes = (attributes: SuezAttributes, startDate: Date, endDate: Date): SuezDailyConsumption[] => {
    const thisMonth = attributes.this_month_consumption || {};
    const prevMonth = attributes.previous_month_consumption || {};
    const monthlyHistory = attributes.history || {};

    const result: SuezDailyConsumption[] = [];
    const existingDates = new Set<string>();

    // 1. Process precise daily values from this month and previous month
    const processDailyObject = (dailyObj: Record<string, number>) => {
        for (const [dateStr, value] of Object.entries(dailyObj)) {
            if (value === null || value === undefined || isNaN(value)) continue;

            const date = new Date(dateStr + 'T00:00:00.000Z');
            if (date >= startDate && date <= endDate) {
                if (!existingDates.has(dateStr)) {
                    result.push({
                        date,
                        value: Number(value),
                        isEstimate: false
                    });
                    existingDates.add(dateStr);
                }
            }
        }
    };

    processDailyObject(thisMonth);
    processDailyObject(prevMonth);

    // 2. Process monthly history and split it into daily estimates to backfill 2025 and 2026
    for (const [monthStr, totalValue] of Object.entries(monthlyHistory)) {
        if (totalValue === null || totalValue === undefined || isNaN(Number(totalValue))) continue;
        const totalLiters = Number(totalValue);

        // Parse "YYYY-MM"
        const parts = monthStr.split('-');
        if (parts.length !== 2) continue;
        const year = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10); // 1-indexed

        if (isNaN(year) || isNaN(month)) continue;

        // Get number of days in this month using UTC to prevent DST transitions
        const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
        if (daysInMonth <= 0) continue;

        const dailyEstimateValue = totalLiters / daysInMonth;

        for (let i = 1; i <= daysInMonth; i++) {
            const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
            const date = new Date(dateStr + 'T00:00:00.000Z');

            if (date >= startDate && date <= endDate) {
                if (!existingDates.has(dateStr)) {
                    result.push({
                        date,
                        value: dailyEstimateValue,
                        isEstimate: true
                    });
                    existingDates.add(dateStr);
                }
            }
        }
    }

    // 3. Sort chronologically
    return result.sort((a, b) => a.date.getTime() - b.date.getTime());
};
