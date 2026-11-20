/** HA metadata service — fixed server-side template mapping lights, sensors and climates to their area, floor and model */
import { haPost } from '@/lib/haClient';
import { logger } from '@/lib/logger';
import type { EntityMetadata, EntityMetadataMap } from './types';

/**
 * One `"<entity_id>": {area, floor, model}` pair. Both key and value go through `tojson`
 * (as the alert templates since audit S15): a quote in a room or model name cannot break the JSON.
 */
const METADATA_ITEM =
    "{% set ns.items = ns.items + [(state.entity_id | tojson) + ':' + ({"
    + "'area': area_name(state.entity_id) or '', "
    + "'floor': floor_name(state.entity_id) or '', "
    + "'model': device_attr(state.entity_id, 'model') or ''"
    + '} | tojson)] %}';

/**
 * WARNING: fixed template, no client input ever reaches it (free templates are admin only, R1).
 */
export const ENTITY_METADATA_TEMPLATE =
    '{% set ns = namespace(items=[]) %}'
    + ['light', 'sensor', 'climate'].map(domain => `{% for state in states.${domain} %}${METADATA_ITEM}{% endfor %}`).join('')
    + "{ {{ ns.items | join(',') }} }";

/** Areas, floors and models change only when the HA configuration is edited. */
export const METADATA_CACHE_TTL_MS = 5 * 60 * 1000;

let metadataCache: { data: EntityMetadataMap; fetchedAt: number } | null = null;

/** Empties the cache (tests). */
export function resetEntityMetadataCache(): void {
    metadataCache = null;
}

const asText = (value: unknown): string => (value === null || value === undefined ? '' : String(value));

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Parses the rendered template into the response shape, normalizing every field to a string.
 *
 * @param raw - Template output: the JSON text, or an object if HA already sent it parsed.
 * @returns The metadata per entity, or null when the output is not a JSON object.
 */
export function parseEntityMetadata(raw: unknown): EntityMetadataMap | null {
    let parsed: unknown = raw;
    if (typeof raw === 'string') {
        try {
            parsed = JSON.parse(raw);
        } catch {
            return null;
        }
    }
    if (!isPlainObject(parsed)) return null;

    const metadata: EntityMetadataMap = {};
    for (const [entityId, value] of Object.entries(parsed)) {
        if (!isPlainObject(value)) continue;
        const entry: EntityMetadata = { area: asText(value.area), floor: asText(value.floor), model: asText(value.model) };
        metadata[entityId] = entry;
    }
    return metadata;
}

/**
 * Area, floor and device model of every light, sensor and climate entity, cached 5 minutes.
 *
 * @returns ok=true with the metadata, or ok=false when HA fails or renders invalid JSON.
 */
export async function getEntityMetadata(): Promise<{ ok: true; data: EntityMetadataMap } | { ok: false }> {
    if (metadataCache && Date.now() - metadataCache.fetchedAt < METADATA_CACHE_TTL_MS) {
        return { ok: true, data: metadataCache.data };
    }

    try {
        const { data, ok } = await haPost<unknown>('/api/template', { template: ENTITY_METADATA_TEMPLATE }, 'metadata');
        if (!ok) return { ok: false };

        const metadata = parseEntityMetadata(data);
        if (!metadata) {
            logger.error('[HAMetadata] Template rendered invalid JSON');
            return { ok: false };
        }
        metadataCache = { data: metadata, fetchedAt: Date.now() };
        return { ok: true, data: metadata };
    } catch (error) {
        logger.error('[HAMetadata] Template call failed', { error: String(error) });
        return { ok: false };
    }
}
