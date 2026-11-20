/** HA metadata types — area, floor and device model of the dashboard entities */

/** Where an entity lives and which device backs it; empty strings when HA knows nothing. */
export interface EntityMetadata {
    area: string;
    floor: string;
    model: string;
}

/** Response body of GET /api/ha/metadata, keyed by entity_id. */
export type EntityMetadataMap = Record<string, EntityMetadata>;
