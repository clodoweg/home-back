/** Petkit fountain — état de la fontaine et activité de boisson par jour */
import { getParisClock, getParisDate, getParisDayString } from '@/lib/paris-time';
import type { FountainDay, FountainDevice, FountainWorkRecord, HAEntityState } from './types';

export const FOUNTAIN_ENTITIES = {
    drinking: 'binary_sensor.eau_pet_drinking',
    drinkCounter: 'sensor.eau_nombre_de_boissons',
} as const;

/** A drink lasting longer than this is a sensor glitch. */
const MAX_DRINK_SECONDS = 300;
/** Default duration of a drink only seen by the counter. */
const COUNTER_DRINK_SECONDS = 30;

const toUnix = (iso: string | undefined) => Math.floor(new Date(iso as string).getTime() / 1000);

/** Seconds since midnight in Paris: morning/afternoon/night are the household's hours. */
const parisSecondsOfDay = (date: Date) => {
    const { hour, minute, second } = getParisClock(date);
    return hour * 3600 + minute * 60 + second;
};

/**
 * Rebuilds the drinks from the occupancy sensor (on/off segments), the drink counter and the
 * current occupancy, newest first.
 *
 * @param drinkingHistory History of the occupancy binary sensor.
 * @param counterHistory History of the drink counter.
 * @param isDrinkingNow Whether the occupancy sensor is currently on.
 * @returns The drinks, newest first.
 */
export function collectDrinks(drinkingHistory: HAEntityState[], counterHistory: HAEntityState[], isDrinkingNow: boolean): FountainWorkRecord[] {
    const drinks: FountainWorkRecord[] = [];

    let lastOnTime: number | null = null;
    for (const entry of drinkingHistory) {
        const time = toUnix(entry.last_changed);
        if (entry.state === 'on') {
            lastOnTime = time;
        } else if (entry.state === 'off' && lastOnTime !== null) {
            const duration = Math.min(time - lastOnTime, MAX_DRINK_SECONDS);
            if (duration > 0) {
                drinks.push({ time: lastOnTime, dayTime: parisSecondsOfDay(new Date(lastOnTime * 1000)), stayTime: duration });
            }
            lastOnTime = null;
        }
    }

    let lastCount = -1;
    for (const entry of counterHistory) {
        const value = parseInt(entry.state);
        if (isNaN(value)) continue;
        if (lastCount !== -1 && value > lastCount) {
            const time = toUnix(entry.last_changed);
            // Only when the occupancy sensor has not already seen this drink
            if (!drinks.some(r => Math.abs(r.time - time) < 60)) {
                drinks.push({ time, dayTime: parisSecondsOfDay(new Date(time * 1000)), stayTime: COUNTER_DRINK_SECONDS });
            }
        }
        lastCount = value;
    }

    if (isDrinkingNow && lastOnTime !== null) {
        const start = getParisClock(new Date(lastOnTime * 1000));
        drinks.push({
            time: lastOnTime,
            dayTime: start.hour * 3600 + start.minute * 60,
            stayTime: Math.min(Math.floor(Date.now() / 1000) - lastOnTime, MAX_DRINK_SECONDS),
        });
    }

    return drinks.sort((a, b) => b.time - a.time);
}

/**
 * Builds the fountain device and one activity summary per requested day.
 *
 * @param states Current HA states.
 * @param history History per entity id.
 * @param days Number of days to summarize, today included.
 * @returns The fountain device and its daily summaries, today first.
 */
export function buildFountain(
    states: HAEntityState[],
    history: Map<string, HAEntityState[]>,
    days: number,
): { device: FountainDevice; fountains: FountainDay[] } {
    const getVal = (id: string) => states.find(s => s.entity_id === id)?.state;

    const drinks = collectDrinks(
        history.get(FOUNTAIN_ENTITIES.drinking) ?? [],
        history.get(FOUNTAIN_ENTITIES.drinkCounter) ?? [],
        getVal(FOUNTAIN_ENTITIES.drinking) === 'on',
    );

    const device: FountainDevice = {
        id: 2,
        deviceId: 2,
        deviceType: 'Ctw3',
        name: 'Fontaine',
        status: {
            powerStatus: getVal('switch.eau_alimentation') === 'on' || getVal('switch.fontaine_alimentation') === 'on' ? 1 : 0,
            runStatus:
                getVal('binary_sensor.eau_pump') === 'on' || getVal('switch.eau_pompe') === 'on' || getVal('switch.fontaine_pompe') === 'on' ? 1 : 0,
            electricStatus:
                getVal('binary_sensor.eau_sur_alimentation_secteur') === 'on' || getVal('binary_sensor.fontaine_secteur') === 'on' ? 2 : 1,
            battery: parseInt(getVal('sensor.eau_battery') || getVal('sensor.fontaine_batterie') || '100'),
            pim: parseInt(getVal('sensor.eau_filtre_restant') || getVal('sensor.fontaine_etat_du_filtre') || '0'),
            waterLevel:
                getVal('binary_sensor.eau_alerte_manque_d_eau') === 'on' || getVal('binary_sensor.fontaine_manque_d_eau') === 'on' ? 1 : 0,
        },
        // Fields read by the widget
        data: {
            status: {
                electricStatus: getVal('binary_sensor.eau_sur_alimentation_secteur') === 'on' ? 2 : 1,
                water_level_status: getVal('binary_sensor.eau_alerte_manque_d_eau') === 'on' ? 1 : 0,
            },
        },
    };

    const fountains: FountainDay[] = [];
    const today = getParisDate(new Date());
    for (let i = 0; i < days; i++) {
        // Paris calendar days, like the front's date picker. Calendar arithmetic, not "now - 24 h",
        // which skips or repeats a day around clock changes.
        const dayStr = new Date(Date.UTC(today.year, today.month, today.day - i)).toISOString().slice(0, 10);
        const dayRecords = drinks.filter(r => getParisDayString(new Date(r.time * 1000)) === dayStr);

        let morning = 0, afternoon = 0, night = 0;
        for (const r of dayRecords) {
            const hour = Math.floor(r.dayTime / 3600);
            if (hour >= 6 && hour < 12) morning++;
            else if (hour >= 12 && hour < 18) afternoon++;
            else night++;
        }

        const isToday = i === 0;
        fountains.push({
            deviceId: 2,
            day: dayStr,
            data: {
                filterPercent: isToday ? parseInt(getVal('sensor.eau_filtre_restant') || '0') : 0,
                lackWarning: isToday ? getVal('binary_sensor.eau_alerte_manque_d_eau') === 'on' : false,
                mode: 1,
                activity: { morning, afternoon, night },
                electricity: {
                    batteryPercent: isToday ? parseInt(getVal('sensor.eau_battery') || '100') : 100,
                    powerStatus: isToday ? (getVal('switch.eau_alimentation') === 'on' ? 1 : 0) : 1,
                },
            },
            workRecords: dayRecords,
        });
    }

    return { device, fountains };
}
