/**
 * Daily usage rules — quels compteurs d'usage calculer, pour quelles entités, et comment
 * (durée active, nombre d'entrées dans un état, nombre de changements, hausse d'un compteur).
 */
import type { HAState } from '@/lib/haClient';
import type { TimedState } from './compute';

/**
 * - `duration`: hours spent in an active state;
 * - `entries`: times the entity entered an active state;
 * - `changes`: times the state changed (an image entity changes on each new picture);
 * - `increase`: rise of a numeric counter, resets included;
 * - `mean`: time-weighted mean of a value (`value`), e.g. a temperature.
 */
export type UsageKind = 'duration' | 'entries' | 'changes' | 'increase' | 'mean';

export interface UsageRule {
    metric: string;
    entityId: string;
    kind: UsageKind;
    isActive?: (state: string, attributes?: Record<string, unknown>) => boolean;
    /** Value of a point, for `mean`. */
    value?: (point: TimedState) => number | null;
    /** The rule reads attributes: its entity's history is fetched with them. */
    needsAttributes?: boolean;
}

const isOn = (state: string) => state === 'on';

/**
 * Same exclusion as the front's PRINTER_LIGHT_PATTERN (`src/constants/entities.ts`): the 3D
 * printer's lights are not home lights.
 */
const PRINTER_LIGHT_PATTERN =
    /^light\.(p1s|x1c|p1p|a1)(_|$)|bambu|(_chamber_light|_lumiere_de_la_chambre|_printer_light)$/;

/** Print status sensor of the Bambu Lab printer, by the suffixes the front also accepts. */
const PRINTER_STATUS_PATTERN =
    /^sensor\.(?:p1s|x1c|p1p|a1|bambu)[a-z0-9_]*_(?:etat_de_l_impression|print_status|print_state|current_stage)$/;
const PRINTER_ACTIVE_STATES = ['printing', 'running', 'prepare', 'preparing'];

const SPA = { climate: 'climate.spa_thermostat', power: 'switch.spa_power' } as const;
const PLUGS = ['switch.prise_pc', 'switch.prise_tv'] as const;
const WASHER_STATUS = 'binary_sensor.washing_machine_status';
const FOUNTAIN_DRINKING = 'binary_sensor.eau_pet_drinking';
const FEEDER = {
    mealImage: 'image.croquettes_dernier_repas',
    distributionImage: 'image.croquettes_derniere_distribution',
    counters: ['sensor.croquettes_total_distribue_reservoir_1', 'sensor.croquettes_total_distribue_reservoir_2'],
} as const;

/**
 * Usage rules for the entities present in HA: an entity missing from the states (device
 * removed, integration renamed) simply produces no metric.
 *
 * @param states - Current HA states.
 * @returns One rule per metric to compute.
 */
export function buildUsageRules(states: HAState[]): UsageRule[] {
    const ids = new Set(states.map(state => state.entity_id));
    const rules: UsageRule[] = [];
    const add = (rule: UsageRule) => {
        if (ids.has(rule.entityId)) rules.push(rule);
    };

    for (const { entity_id } of states) {
        if (entity_id.startsWith('light.') && !PRINTER_LIGHT_PATTERN.test(entity_id)) {
            rules.push({ metric: `light_hours:${entity_id}`, entityId: entity_id, kind: 'duration', isActive: isOn });
        } else if (entity_id.startsWith('alarm_control_panel.')) {
            rules.push({ metric: `alarm_arms:${entity_id}`, entityId: entity_id, kind: 'entries', isActive: s => s.startsWith('armed_') });
            rules.push({ metric: `alarm_triggers:${entity_id}`, entityId: entity_id, kind: 'entries', isActive: s => s === 'triggered' });
        } else if (entity_id.startsWith('binary_sensor.aarlo_motion_')) {
            rules.push({ metric: `motion:${entity_id}`, entityId: entity_id, kind: 'entries', isActive: isOn });
        } else if (PRINTER_STATUS_PATTERN.test(entity_id)) {
            const isPrinting = (s: string) => PRINTER_ACTIVE_STATES.includes(s.trim().toLowerCase());
            rules.push({ metric: 'printer_hours', entityId: entity_id, kind: 'duration', isActive: isPrinting });
            rules.push({ metric: 'printer_jobs', entityId: entity_id, kind: 'entries', isActive: isPrinting });
        }
    }

    // `heat` is the thermostat's mode, on all day: the heater runs when `hvac_action` says
    // `heating`. Without that attribute (older integration), the mode is all there is.
    add({
        metric: 'spa_heating_hours',
        entityId: SPA.climate,
        kind: 'duration',
        needsAttributes: true,
        isActive: (state, attributes) =>
            typeof attributes?.hvac_action === 'string' ? attributes.hvac_action === 'heating' : state === 'heat',
    });
    // Climate entities have no long-term statistics: the water temperature is averaged here.
    add({
        metric: 'spa_temperature',
        entityId: SPA.climate,
        kind: 'mean',
        needsAttributes: true,
        value: point => {
            const temperature = Number(point.attributes?.current_temperature);
            return point.attributes?.current_temperature === undefined || !Number.isFinite(temperature) ? null : temperature;
        },
    });
    add({ metric: 'spa_on_hours', entityId: SPA.power, kind: 'duration', isActive: isOn });
    for (const plug of PLUGS) add({ metric: `plug_hours:${plug}`, entityId: plug, kind: 'duration', isActive: isOn });
    add({ metric: 'washer_cycles', entityId: WASHER_STATUS, kind: 'entries', isActive: isOn });
    add({ metric: 'washer_hours', entityId: WASHER_STATUS, kind: 'duration', isActive: isOn });
    add({ metric: 'fountain_drinks', entityId: FOUNTAIN_DRINKING, kind: 'entries', isActive: isOn });
    add({ metric: 'feeder_meals', entityId: FEEDER.mealImage, kind: 'changes' });
    add({ metric: 'feeder_distributions', entityId: FEEDER.distributionImage, kind: 'changes' });
    for (const counter of FEEDER.counters) add({ metric: `feeder_portions:${counter}`, entityId: counter, kind: 'increase' });

    return rules;
}
