/**
 * GRDF Data Service
 * Extracts and maps gas consumption data from Home Assistant sensors.
 */
import { haGet } from '../../haClient';
import type { GazparAttributes, GrdfDailyConsumption } from './types';
import type { HAState } from '../../haClient';
import { logger } from '@/lib/logger';

/**
 * Retrieves GRDF consumption records from Home Assistant.
 * 
 * @param start - Optional start date.
 * @param end - Optional end date.
 * @returns Array of consumption records.
 */
export const getGrdfData = async (start?: Date, end?: Date): Promise<GrdfDailyConsumption[]> => {
    // Default range
    const endDate = end || new Date();
    // 30 days before the end date (the former setDate mixed the end day with the current month)
    const startDate = start || new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

    try {
        // Fetch current state of sensor.gazpar to access its attributes
        const response = await haGet<HAState>('/api/states/sensor.gazpar');

        if (!response.ok || !response.data || !response.data.attributes) {
            logger.warn("[GRDF] sensor.gazpar has no valid attributes");
            return [];
        }

        return mapGrdfAttributes(response.data.attributes as GazparAttributes, startDate, endDate);
    } catch (error) {
        logger.error("[GRDF] Failed to fetch GRDF data from HA", { error: String(error) });
        return [];
    }
};

/**
 * Pure function to map Gazpar sensor attributes to standardized consumption records.
 * 
 * @param attributes - Raw Home Assistant sensor attributes.
 * @param startDate - Filter start date.
 * @param endDate - Filter end date.
 * @returns Standardized consumption records array.
 */
export const mapGrdfAttributes = (attributes: GazparAttributes, startDate: Date, endDate: Date): GrdfDailyConsumption[] => {
    const rawDaily = attributes.daily || [];
    const rawMonthly = attributes.monthly || [];

    const result: GrdfDailyConsumption[] = [];
    const existingDates = new Set<string>();

    // 1. Process Daily/Weekly data first (Higher precision)
    for (const entry of rawDaily) {
        if (!entry.time_period || !entry.energy_kwh) continue;

        // Try to match single date "DD/MM/YYYY" (Daily value)
        const singleMatch = entry.time_period.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        if (singleMatch) {
            const dayDate = parseFrenchDate(entry.time_period);

            if (dayDate >= startDate && dayDate <= endDate) {
                const dateStr = dayDate.toISOString().split('T')[0];
                if (!existingDates.has(dateStr)) {
                    const temp = entry.temperature_degC ? parseFloat(String(entry.temperature_degC)) : undefined;
                    result.push({
                        date: dayDate,
                        value: parseFloat(String(entry.energy_kwh)),
                        temp: temp,
                        isEstimate: false
                    });
                    existingDates.add(dateStr);
                }
            }
            continue;
        }

        // Try to match range "Du DD/MM/YYYY au DD/MM/YYYY" (Weekly aggregated)
        const rangeMatch = entry.time_period.match(/Du (\d{2}\/\d{2}\/\d{4}) au (\d{2}\/\d{2}\/\d{4})/);
        if (rangeMatch) {
            const periodStart = parseFrenchDate(rangeMatch[1]);
            const periodEnd = parseFrenchDate(rangeMatch[2]);
            const totalKwH = parseFloat(String(entry.energy_kwh));

            const diffTime = Math.abs(periodEnd.getTime() - periodStart.getTime());
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;

            if (diffDays <= 0) continue;
            const dailyValue = totalKwH / diffDays;

            for (let i = 0; i < diffDays; i++) {
                const dayDate = new Date(periodStart.getTime() + i * 24 * 60 * 60 * 1000);

                if (dayDate >= startDate && dayDate <= endDate) {
                    const dateStr = dayDate.toISOString().split('T')[0];
                    if (!existingDates.has(dateStr)) {
                        result.push({
                            date: dayDate,
                            value: dailyValue,
                            temp: undefined,
                            isEstimate: true
                        });
                        existingDates.add(dateStr);
                    }
                }
            }
            continue;
        }
    }

    // 2. Process Monthly data (Lower precision, backfill)
    for (const entry of rawMonthly) {
        if (!entry.time_period || !entry.energy_kwh) continue;

        const monthDate = parseFrenchMonth(entry.time_period);
        if (!monthDate) continue;

        const totalKwH = parseFloat(String(entry.energy_kwh));
        // Get number of days in this month using UTC date to avoid DST/TZ issues
        const daysInMonth = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth() + 1, 0)).getUTCDate();
        const dailyValue = totalKwH / daysInMonth;

        for (let i = 1; i <= daysInMonth; i++) {
            const dayDate = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth(), i));

            if (dayDate >= startDate && dayDate <= endDate) {
                const dateStr = dayDate.toISOString().split('T')[0];
                if (!existingDates.has(dateStr)) {
                    result.push({
                        date: dayDate,
                        value: dailyValue,
                        temp: undefined,
                        isEstimate: true
                    });
                    existingDates.add(dateStr);
                }
            }
        }
    }

    result.sort((a, b) => a.date.getTime() - b.date.getTime());
    return result;
};

const parseFrenchDate = (dateStr: string): Date => {
    const [day, month, year] = dateStr.split('/').map(Number);
    return new Date(Date.UTC(year, month - 1, day));
};

const parseFrenchMonth = (dateStr: string): Date | null => {
    const parts = dateStr.split(' ');
    if (parts.length !== 2) return null;

    const monthName = parts[0].toLowerCase();
    const year = parseInt(parts[1], 10);

    const months: { [key: string]: number } = {
        'janvier': 0, 'février': 1, 'mars': 2, 'avril': 3, 'mai': 4, 'juin': 5,
        'juillet': 6, 'août': 7, 'septembre': 8, 'octobre': 9, 'novembre': 10, 'décembre': 11
    };

    if (months[monthName] !== undefined && !isNaN(year)) {
        return new Date(Date.UTC(year, months[monthName], 1));
    }
    return null;
};
