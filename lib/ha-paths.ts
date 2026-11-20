/**
 * HA paths — construction sûre des chemins Home Assistant à partir des entrées client.
 *
 * WARNING: every proxied call carries the HA admin token. Next decodes dynamic route
 * params (`..%2F` becomes `../`) and `fetch` normalizes `..` segments, so any client
 * value reaching a path must be validated against an allowlist, then encoded.
 */
import { z } from 'zod';
import { entityIdPattern } from './validators';

const isoDateTimeSchema = z.iso.datetime({ offset: true });
const MAX_ENTITIES_PER_HISTORY_CALL = 100;

/** HA history flags whose presence alone switches the option on. */
const HISTORY_FLAGS = ['minimal_response', 'no_attributes', 'significant_changes_only'] as const;

/**
 * Media IDs built by the Petkit service:
 * `media-source://local/media/<device>/<date>/<category>/snapshot/<device>_<time>.jpg`.
 * Segments are restricted to `[A-Za-z0-9_-]`, which rules out `..` and encoded characters.
 */
const MEDIA_CONTENT_ID_PATTERN = /^media-source:\/\/(local|petkit)\/((?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:jpe?g|png))$/;

const isIsoDateTime = (value: string | null): value is string =>
    value !== null && isoDateTimeSchema.safeParse(value).success;

/**
 * Parses a comma-separated list of entity IDs.
 *
 * @param value - Raw `filter_entity_id` / `entity_id` query value.
 * @returns The list, or null if empty, too long or containing an invalid ID.
 */
function parseEntityIdList(value: string | null): string[] | null {
    if (!value) return null;
    const ids = value.split(',').map(id => id.trim());
    if (ids.length > MAX_ENTITIES_PER_HISTORY_CALL) return null;
    return ids.every(id => entityIdPattern.test(id)) ? ids : null;
}

/**
 * Builds the HA history path from the two formats the front uses:
 * `?entity_id=&start_time=&end_time=` or `/period/<ISO>?filter_entity_id=&end_time=`.
 *
 * @param slug - Catch-all route segments (already decoded by Next).
 * @param searchParams - Query of the incoming request.
 * @returns The HA path with a rebuilt query, or null if any input is invalid.
 */
export function buildHistoryPath(slug: string[], searchParams: URLSearchParams): string | null {
    const query = new URLSearchParams();
    let startTime: string | null;

    if (slug.length === 0) {
        const entityIds = parseEntityIdList(searchParams.get('entity_id'));
        startTime = searchParams.get('start_time');
        const endTime = searchParams.get('end_time');
        if (!entityIds || !isIsoDateTime(startTime) || !isIsoDateTime(endTime)) return null;
        query.set('filter_entity_id', entityIds.join(','));
        query.set('end_time', endTime);
    } else {
        if (slug[0] !== 'period' || slug.length > 2) return null;
        startTime = slug[1] ?? null;
        if (startTime !== null && !isIsoDateTime(startTime)) return null;

        const entityIds = parseEntityIdList(searchParams.get('filter_entity_id'));
        if (!entityIds) return null;
        query.set('filter_entity_id', entityIds.join(','));

        const endTime = searchParams.get('end_time');
        if (endTime !== null) {
            if (!isIsoDateTime(endTime)) return null;
            query.set('end_time', endTime);
        }
    }

    for (const flag of HISTORY_FLAGS) {
        if (searchParams.has(flag)) query.set(flag, '');
    }

    const period = startTime ? `/${encodeURIComponent(startTime)}` : '';
    return `/api/history/period${period}?${query.toString()}`;
}

/**
 * Parses a Home Assistant media-source ID restricted to the local and Petkit providers.
 *
 * @param mediaContentId - Raw `media_content_id` query value.
 * @returns The provider and the relative file path, or null if not allowed.
 */
export function parseMediaContentId(mediaContentId: string): { provider: 'local' | 'petkit'; relativePath: string } | null {
    const match = MEDIA_CONTENT_ID_PATTERN.exec(mediaContentId);
    if (!match) return null;
    return { provider: match[1] as 'local' | 'petkit', relativePath: match[2] };
}

/**
 * Tells whether a URL returned by Home Assistant points to Home Assistant itself,
 * which is the only host allowed to receive the HA token.
 *
 * @param url - Absolute or root-relative URL.
 * @param haBaseUrl - Configured `HA_BASE_URL`.
 * @returns The absolute URL when it stays on the HA origin, otherwise null.
 */
export function resolveHaUrl(url: string, haBaseUrl: string): string | null {
    try {
        const haOrigin = new URL(haBaseUrl).origin;
        const resolved = new URL(url, haOrigin);
        return resolved.origin === haOrigin ? resolved.toString() : null;
    } catch {
        return null;
    }
}
