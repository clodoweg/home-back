/**
 * Enedis API Client
 * Low-level functions to interact with the MyElectricalData API.
 */
import { logger } from '@/lib/logger';

const getPDL = () => process.env.ENEDIS_PDL;
const getTOKEN = () => process.env.ENEDIS_TOKEN;
const API_BASE_URL = 'https://www.myelectricaldata.fr';

const getHeaders = () => ({
    'Authorization': getTOKEN() || '',
    'Content-Type': 'application/json',
});

/**
 * Format a date object as a YYYY-MM-DD string.
 * 
 * @param date - Date object to format.
 * @returns Formatted date string.
 */
export const formatDate = (date: Date): string => {
    return date.toISOString().split('T')[0];
};

/**
 * Performs an authenticated fetch to the Enedis API.
 * 
 * @param endpoint - The API endpoint to fetch.
 * @returns Parsed JSON response.
 */
export async function apiFetch(endpoint: string) {
    const url = `${API_BASE_URL}/${endpoint}`;
    logger.debug(`[Enedis] Fetching ${url}`);
    const response = await fetch(url, { headers: getHeaders() });

    if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(`[Enedis] API Error ${response.status}: ${response.statusText} ${errorBody}`);
    }

    return response.json();
}

/**
 * Builds a date-range fetcher for a given Enedis API path.
 * @param kind - Enedis API path segment (e.g., 'daily_consumption').
 */
const fetchInterval = (kind: string) => async (start: Date, end: Date) => {
    const pdl = getPDL();
    if (!pdl) throw new Error('Missing ENEDIS_PDL environment variable');
    return apiFetch(`${kind}/${pdl}/start/${formatDate(start)}/end/${formatDate(end)}`);
};

export const fetchDailyConsumption = fetchInterval('daily_consumption');
export const fetchDailyMaxPower = fetchInterval('daily_consumption_max_power');
export const fetchLoadCurve = fetchInterval('consumption_load_curve');
