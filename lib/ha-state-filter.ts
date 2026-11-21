/** HA state filter — retire des états renvoyés au front les attributs qui localisent la famille ou ouvrent une caméra */
import type { HAState } from './haClient';

/**
 * WARNING: attributes never sent to the front, whatever the group (audit M1). Location: device
 * trackers, people and zones carry the GPS position of the family and of the house. Access: a
 * camera's `access_token`, and `entity_picture` that embeds it, open the camera image on HA without
 * our permission checks; Arlo's `last_video` is a signed download URL. The dashboard reads none of
 * them, and the front persists the states in localStorage.
 */
const STRIPPED_ATTRIBUTES = new Set([
    'latitude',
    'longitude',
    'gps_accuracy',
    'altitude',
    'access_token',
    'entity_picture',
    'last_video',
]);

/**
 * Attributes kept without their query string. Arlo's `last_thumbnail` is a signed URL whose
 * signature lives in the query: anyone holding it would see the picture without the cameras right,
 * and the front puts it in an image URL (logged by Cloudflare and Vercel). The cameras widget only
 * reads the capture timestamp in its path and uses the value as a change marker.
 */
const UNSIGNED_ATTRIBUTES = new Set(['last_thumbnail']);

/** A value without its query string and fragment; anything but a string is kept as is. */
const withoutQueryString = (value: unknown): unknown =>
    typeof value === 'string' ? value.split(/[?#]/, 1)[0] : value;

/**
 * Copies a Home Assistant state without its sensitive attributes. The input is never mutated: the
 * states cache shares its objects with the alert engine.
 *
 * @param state - State as Home Assistant returns it (attributes optional, e.g. minimal history).
 * @returns The same state when it has no attributes, otherwise a copy with filtered attributes.
 */
export function sanitizeHAState<T extends Partial<HAState>>(state: T): T {
    if (!state?.attributes || typeof state.attributes !== 'object') return state;

    const attributes: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(state.attributes)) {
        if (STRIPPED_ATTRIBUTES.has(name)) continue;
        attributes[name] = UNSIGNED_ATTRIBUTES.has(name) ? withoutQueryString(value) : value;
    }
    return { ...state, attributes };
}

/**
 * Filters a list of Home Assistant states (GET /api/ha/states).
 *
 * @param states - States to filter.
 * @returns New list of filtered states.
 */
export function sanitizeHAStates<T extends Partial<HAState>>(states: T[]): T[] {
    return states.map(sanitizeHAState);
}

/**
 * Filters a Home Assistant history answer: one list of states per entity. A device tracker's history
 * is otherwise a GPS trail.
 *
 * @param history - Body returned by `/api/history/period`.
 * @returns The filtered history; anything that is not a list of lists is returned unchanged.
 */
export function sanitizeHAHistory(history: unknown): unknown {
    if (!Array.isArray(history)) return history;
    return history.map(series => (Array.isArray(series) ? sanitizeHAStates(series as Partial<HAState>[]) : series));
}
