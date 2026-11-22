/**
 * Alert check runner — fetches current HA state, detects transitions against
 * last snapshot, dispatches each alert to the admin users (the front's bell and Web Push),
 * persists snapshot.
 */
import { haGet, haPost, type HAState } from '@/lib/haClient';
import prisma from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { notifyUser, pruneOldNotifications } from '@/lib/integrations/notifications';
import { detectAlerts } from './detector';
import { loadSnapshot, saveSnapshot } from './snapshot';
import { shouldEmit } from './throttle';
import type { NotificationPreferences } from './types';


const AREA_ITEM = "{% set ns.items = ns.items + [(state.entity_id | tojson) + ':' + ((area_name(state.entity_id) or '') | tojson)] %}";

/**
 * Single template mapping every light and every humidity/temperature sensor to its area.
 * One HA render per check instead of three full passes over the states.
 */
const AREA_MAPPING_TEMPLATE =
    '{% set ns = namespace(items=[]) %}'
    + `{% for state in states.light %}${AREA_ITEM}{% endfor %}`
    + `{% for state in states.sensor %}{% if state.attributes.device_class in ['humidity', 'temperature'] %}${AREA_ITEM}{% endif %}{% endfor %}`
    + "{ {{ ns.items | join(',') }} }";

/**
 * Fetches the `entity_id → area name` mapping. Area names are user-editable in HA: the
 * template serializes them with `tojson`, so a quote in a room name cannot break JSON.parse
 * and silently disable the alerts.
 *
 * @returns The mapping, or {} when HA fails or returns invalid JSON.
 */
async function getAreaMapping(): Promise<Record<string, string>> {
    const { data, ok } = await haPost<string>('/api/template', { template: AREA_MAPPING_TEMPLATE }, 'alerts-areas');
    if (!ok || !data) return {};
    try {
        return JSON.parse(data);
    } catch {
        return {};
    }
}

/**
 * Whether any light is on, per area.
 *
 * @param states Current HA states.
 * @param mapping Entity → area mapping.
 * @returns { areaName: anyOn }.
 */
function getLightsByArea(states: HAState[], mapping: Record<string, string>): Record<string, boolean> {
    const byArea: Record<string, boolean> = {};
    for (const light of states) {
        if (!light.entity_id.startsWith('light.')) continue;
        const area = mapping[light.entity_id];
        if (!area) continue;
        const isOn = light.state === 'on';
        byArea[area] = (byArea[area] || false) || isOn;
    }
    return byArea;
}

/**
 * Current humidity per area (average when an area has several sensors).
 *
 * @param states Current HA states.
 * @param mapping Entity → area mapping.
 * @returns { areaName: humidity % }.
 */
function getHumidityByArea(states: HAState[], mapping: Record<string, string>): Record<string, number> {
    const sumByArea: Record<string, { total: number; count: number }> = {};
    for (const sensor of states) {
        if (sensor.attributes?.device_class !== 'humidity') continue;
        const area = mapping[sensor.entity_id];
        if (!area) continue;
        const val = parseFloat(sensor.state);
        if (isNaN(val)) continue;
        if (!sumByArea[area]) sumByArea[area] = { total: 0, count: 0 };
        sumByArea[area].total += val;
        sumByArea[area].count += 1;
    }

    const byArea: Record<string, number> = {};
    for (const [area, { total, count }] of Object.entries(sumByArea)) {
        byArea[area] = total / count;
    }
    return byArea;
}

/**
 * Determines whether a Home Assistant sensor entity is a Sonoff temperature sensor
 * (i.e. measures both temperature and humidity, or follows Sonoff naming convention).
 * Excludes batteries, firmware sensors, motion detectors, sirens, NAS, 3D printers, etc.
 *
 * @param sensor The Home Assistant state object.
 * @param humidityEntityIds Set of all entity_ids of humidity sensors in HA.
 * @returns True if the sensor is a Sonoff temperature sensor.
 */
export function isSonoffTemperatureSensor(sensor: Pick<HAState, 'entity_id'>, humidityEntityIds: Set<string>): boolean {
    const id = sensor.entity_id;
    if (id.endsWith('_batterie') || id.endsWith('_micrologiciel') || id.endsWith('_battery')) {
        return false;
    }
    if (id.startsWith('sensor.temperature_') || id.startsWith('sensor.temp_')) {
        return true;
    }
    // The humidity twin may be named in French or in English
    const candidateIds = [
        id.replace(/_temperature$/, '_humidite'),
        id.replace(/_temperature$/, '_humidity'),
        id.replace(/_temp$/, '_hum'),
        id.replace(/temperature/g, 'humidite').replace(/temp/g, 'hum'),
        id.replace(/temperature/g, 'humidity'),
    ];
    return candidateIds.some(candidate => humidityEntityIds.has(candidate));
}

/**
 * Current temperature per area, from the Sonoff sensors (temperature + humidity). No average:
 * the exact Sonoff reading is used.
 *
 * @param states Current HA states.
 * @param mapping Entity → area mapping.
 * @returns { areaName: temperature °C }.
 */
function getTemperatureByArea(states: HAState[], mapping: Record<string, string>): Record<string, number> {
    const humidityEntityIds = new Set(
        states
            .filter((s) => s.attributes?.device_class === 'humidity')
            .map((s) => s.entity_id),
    );

    const byArea: Record<string, number> = {};
    for (const sensor of states) {
        if (sensor.attributes?.device_class !== 'temperature') continue;
        if (!isSonoffTemperatureSensor(sensor, humidityEntityIds)) continue;

        const area = mapping[sensor.entity_id];
        if (!area) continue;
        const val = parseFloat(sensor.state);
        if (isNaN(val) || val === 0) continue; // skip 0 values (sensor connection issue)

        byArea[area] = val;
    }

    return byArea;
}

export interface AlertCheckResult {
    ok: boolean;
    eventsDetected: number;
    adminsNotified: number;
    /** Notifications stored for the front's bell (one per admin and alert). */
    notificationsStored: number;
}

export async function runAlertCheck(): Promise<AlertCheckResult> {
    const { data: states, ok } = await haGet<HAState[]>('/api/states', 'alerts-states');
    if (!ok || !Array.isArray(states)) {
        logger.error('[Alerts] Failed to fetch HA states');
        return { ok: false, eventsDetected: 0, adminsNotified: 0, notificationsStored: 0 };
    }

    const [mapping, previous] = await Promise.all([getAreaMapping(), loadSnapshot()]);
    const lightsByArea = getLightsByArea(states, mapping);
    const humidityByArea = getHumidityByArea(states, mapping);
    const temperatureByArea = getTemperatureByArea(states, mapping);

    // Fetch primary admin preferences to get custom notification thresholds
    const primaryAdmin = await prisma.user.findFirst({
        where: { group: 'admin' },
        select: { widgetPreferences: true },
    });
    const adminPrefs = (primaryAdmin?.widgetPreferences as Record<string, unknown>) || {};
    const spaTempThreshold = typeof adminPrefs.notificationSpaTempThreshold === 'number'
        ? adminPrefs.notificationSpaTempThreshold
        : undefined;
    const tempMinThreshold = typeof adminPrefs.notificationTempMinThreshold === 'number'
        ? adminPrefs.notificationTempMinThreshold
        : undefined;
    const tempMaxThreshold = typeof adminPrefs.notificationTempMaxThreshold === 'number'
        ? adminPrefs.notificationTempMaxThreshold
        : undefined;
    const humidityMinThreshold = typeof adminPrefs.notificationHumidityMinThreshold === 'number'
        ? adminPrefs.notificationHumidityMinThreshold
        : undefined;
    const humidityMaxThreshold = typeof adminPrefs.notificationHumidityMaxThreshold === 'number'
        ? adminPrefs.notificationHumidityMaxThreshold
        : undefined;

    const { events, next } = detectAlerts({
        states,
        lightsByArea,
        humidityByArea,
        temperatureByArea,
        previous,
        spaTempThreshold,
        tempMinThreshold,
        tempMaxThreshold,
        humidityMinThreshold,
        humidityMaxThreshold,
    });

    await saveSnapshot(next);

    if (events.length === 0) {
        return { ok: true, eventsDetected: 0, adminsNotified: 0, notificationsStored: 0 };
    }

    // Every admin gets the bell and push notifications.
    const admins = await prisma.user.findMany({
        where: { group: 'admin' },
        select: {
            id: true,
            notificationPreferences: true,
        },
    });

    let notificationsStored = 0;
    for (const admin of admins) {
        const prefs = (admin.notificationPreferences as NotificationPreferences) || {};
        for (const event of events) {
            if (prefs[event.category] === false) continue;
            const allowed = await shouldEmit(admin.id, event.throttleKey);
            if (!allowed) continue;

            if (await notifyUser(admin.id, event)) notificationsStored++;
        }
    }
    await pruneOldNotifications();

    return {
        ok: true,
        eventsDetected: events.length,
        adminsNotified: admins.length,
        notificationsStored,
    };
}
