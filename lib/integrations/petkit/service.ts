/**
 * Petkit service — données du distributeur et de la fontaine, calculées en direct depuis
 * Home Assistant (aucune base, aucune synchronisation en arrière-plan).
 */
import { subDays } from 'date-fns';
import { haGet, haPost } from '@/lib/haClient';
import { getCachedStates } from '@/lib/ha-states-cache';
import { logger } from '@/lib/logger';
import { buildFeeder, FEEDER_ENTITIES } from './feeder';
import { buildFountain, FOUNTAIN_ENTITIES } from './fountain';
import type { HAEntityState, PetkitData } from './types';

/** Entities whose history feeds the synthesis, fetched in a single HA call. */
const HISTORY_ENTITIES = [
    FEEDER_ENTITIES.mealImage,
    FEEDER_ENTITIES.distributionImage,
    FEEDER_ENTITIES.visitImage,
    FEEDER_ENTITIES.movementImage,
    FEEDER_ENTITIES.dishBeforeImage,
    FEEDER_ENTITIES.dishAfterImage,
    FEEDER_ENTITIES.counter1,
    FEEDER_ENTITIES.counter2,
    FEEDER_ENTITIES.rawSchedule,
    FOUNTAIN_ENTITIES.drinking,
    FOUNTAIN_ENTITIES.drinkCounter,
];

const toHaSeconds = (date: Date) => date.toISOString().split('.')[0] + 'Z';

/**
 * Fetches the history of every Petkit entity in one call, indexed by entity id.
 * HA omits entities without data, so results are matched by entity id, not by position.
 *
 * @param now Reference instant.
 * @param days Number of days of history.
 * @returns The history per entity id (empty map when HA fails).
 */
async function fetchPetkitHistory(now: Date, days: number): Promise<Map<string, HAEntityState[]>> {
    // 5-minute buffer so that events recorded right now are included
    const bufferedEnd = toHaSeconds(new Date(now.getTime() + 5 * 60 * 1000));
    const { data, ok } = await haGet<HAEntityState[][]>(
        // no_attributes: the synthesis only reads states, attributes would multiply the payload
        `/api/history/period/${toHaSeconds(subDays(now, days))}?filter_entity_id=${HISTORY_ENTITIES.join(',')}&end_time=${bufferedEnd}&no_attributes`,
        'petkit-history-batch',
    );

    const history = new Map<string, HAEntityState[]>();
    if (!ok || !Array.isArray(data)) return history;

    for (const entityHistory of data) {
        const entityId = Array.isArray(entityHistory) ? entityHistory[0]?.entity_id : undefined;
        if (entityId && (HISTORY_ENTITIES as string[]).includes(entityId)) {
            history.set(entityId, entityHistory);
        }
    }
    return history;
}

/**
 * Gets the Petkit feeder and fountain data, synthesized from the current HA states and,
 * with history access, from their history.
 *
 * @param days Number of days of history and fountain summaries.
 * @param hasHistoryAccess Whether the caller may see history and image previews.
 * @returns Devices, timeline records (newest first) and daily fountain summaries.
 */
export async function getFormattedPetkitData(days: number, hasHistoryAccess: boolean): Promise<PetkitData> {
    const now = new Date();
    // States come from the shared cache; the history does not depend on them, so both run together
    const [{ data: states, ok }, history] = await Promise.all([
        getCachedStates(),
        hasHistoryAccess ? fetchPetkitHistory(now, days) : Promise.resolve(new Map<string, HAEntityState[]>()),
    ]);
    if (!ok || !states) {
        logger.error('[PetKit] Failed to fetch HA states');
        return {
            devices: [],
            records: [],
            fountains: [],
            lastSyncedAt: new Date().toISOString(),
            historyHealth: { ok: true, status: 200 },
        };
    }

    const devices: PetkitData['devices'] = [];
    let records: PetkitData['records'] = [];
    let fountains: PetkitData['fountains'] = [];

    if (states.some(s => s.entity_id.includes('croquettes'))) {
        const feeder = buildFeeder(states, history, hasHistoryAccess);
        devices.push(feeder.device);
        records = feeder.records;
        logger.info(`[PetKit] ${records.length} records synthesized`);
    }

    if (states.some(s => s.entity_id.includes('.eau_') || s.entity_id.includes('fontaine'))) {
        const fountain = buildFountain(states, history, days);
        devices.push(fountain.device);
        fountains = fountain.fountains;
    }

    return { devices, records, fountains, lastSyncedAt: new Date().toISOString() };
}

/**
 * Triggers a manual feed: sets the amount of each hopper, then presses the distribution
 * button. The button is pressed even when setting an amount fails.
 *
 * @param _deviceId Feeder id (single feeder today).
 * @param amount1 Portions from hopper 1.
 * @param amount2 Portions from hopper 2.
 * @returns true when HA accepted the button press.
 */
export async function triggerFeederManual(_deviceId: number, amount1: number, amount2: number): Promise<boolean> {
    try {
        const res1 = await haPost('/api/services/text/set_value', {
            entity_id: 'text.croquettes_distribution_manuelle_reservoir_1',
            value: String(amount1),
        }, 'petkit-feeder-amount-1');

        const res2 = await haPost('/api/services/text/set_value', {
            entity_id: 'text.croquettes_distribution_manuelle_reservoir_2',
            value: String(amount2),
        }, 'petkit-feeder-amount-2');

        if (!res1.ok || !res2.ok) {
            logger.warn('[PetKit] Failed to set manual amounts for one or both reservoirs', { res1Ok: res1.ok, res2Ok: res2.ok });
        }

        const result = await haPost('/api/services/button/press', {
            entity_id: 'button.croquettes_distribution_manuelle',
        }, 'petkit-feeder-manual');

        return result.ok;
    } catch (error) {
        logger.error('[PetKit] Error triggering manual feed via HA', { error: String(error) });
        return false;
    }
}
