/**
 * Characterization of detectAlerts for every category, before it is split in lot 4 of the
 * audit (F08). Each case freezes the CURRENT transition rules, including quirks such as
 * the printer fallback (F04).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { detectAlerts } from '@/lib/integrations/alerts/detector';
import type { AlertSnapshot } from '@/lib/integrations/alerts/types';

type State = { entity_id: string; state: string; last_changed?: string; last_updated?: string; attributes?: Record<string, unknown> };

const s = (entity_id: string, state: string, extra: Partial<State> = {}): State => ({ entity_id, state, attributes: {}, ...extra });

function detect(states: State[], previous: AlertSnapshot, extra: Partial<Parameters<typeof detectAlerts>[0]> = {}) {
    return detectAlerts({ states, lightsByArea: {}, humidityByArea: {}, previous, ...extra });
}

const categories = (events: { category: string; throttleKey: string }[]) => events.map(e => e.throttleKey);

describe('detectAlerts — alarm edge cases', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    it('reports a missed transition when the state is unchanged but last_changed moved', () => {
        const { events } = detect(
            [s('alarm_control_panel.somfy_home_alarm_maison', 'armed_night', { last_changed: '2026-10-22T10:00:00Z' })],
            { alarm: { state: 'armed_night', lastChanged: '2026-10-22T08:00:00Z' } },
        );

        expect(events).toEqual([
            { category: 'alarm', throttleKey: 'alarm:state:transition:2026-10-22T10:00:00Z', message: '🛡️ <b>Alarme activée (nuit)</b> (transition manquée)' },
        ]);
    });

    it('labels every alarm state', () => {
        const labels = ['arming', 'disarming', 'pending'].map(state =>
            detect([s('alarm_control_panel.somfy_home_alarm_maison', state)], { alarm: { state: 'disarmed' } }).events[0],
        );

        expect(labels.map(e => e.message)).toEqual([
            "🛡️ <b>Alarme en cours d'activation</b>",
            '🛡️ <b>Alarme en cours de désactivation</b>',
            '🛡️ <b>Alarme pending</b>',
        ]);
    });

    it('emits the siren event', () => {
        const { events } = detect([s('switch.somfy_home_alarm_siren', 'on')], { alarm: { sirenOn: false } });
        expect(events).toEqual([{ category: 'alarm', throttleKey: 'alarm:siren', message: '🚨 <b>Sirène déclenchée !</b>' }]);
    });

    it('emits an SOS event when the configured SOS entity is updated', async () => {
        vi.stubEnv('ALARM_SOS_ENTITY', 'event.sos_button');
        vi.resetModules();
        const { detectAlerts: detectWithSos } = await import('@/lib/integrations/alerts/detector');

        const run = (lastUpdated: string, previous: AlertSnapshot) =>
            detectWithSos({ states: [s('event.sos_button', 'x', { last_updated: lastUpdated })], lightsByArea: {}, humidityByArea: {}, previous });

        expect(categories(run('2026-10-22T10:00:00Z', { alarm: { sosLastUpdated: '2026-10-22T09:00:00Z' } }).events)).toEqual(['alarm:sos']);
        expect(run('2026-10-22T10:00:00Z', {}).events).toEqual([]);
        expect(run('2026-10-22T10:00:00Z', { alarm: { sosLastUpdated: '2026-10-22T10:00:00Z' } }).events).toEqual([]);
    });
});

describe('detectAlerts — spa, fountain and feeder', () => {
    const spa = (temp: number) => s('climate.spa_thermostat', 'heat', { attributes: { current_temperature: temp } });

    it('alerts when the spa crosses the threshold, both ways, only after a known previous state', () => {
        expect(detect([spa(35)], { spa: { belowThreshold: false } }).events[0]).toEqual({
            category: 'spa',
            throttleKey: 'spa:below37',
            message: '🛁 <b>Spa sous 37°C</b> (actuellement 35.0°C)',
        });
        expect(categories(detect([spa(38.26)], { spa: { belowThreshold: true } }).events)).toEqual(['spa:above37']);
        expect(detect([spa(35)], {}).events).toEqual([]);
        expect(categories(detect([spa(39)], { spa: { belowThreshold: false } }, { spaTempThreshold: 40 }).events)).toEqual(['spa:below40']);
        expect(detect([s('climate.spa_thermostat', 'off')], {}).next.spa).toBeUndefined();
        // Unavailable climate entity: no reading, no crash, no state change
        const unavailable = s('climate.spa_thermostat', 'unavailable', { attributes: { current_temperature: null } });
        expect(detect([unavailable], { spa: { belowThreshold: false } })).toMatchObject({ events: [], next: {} });
        expect(detect([unavailable], { spa: { belowThreshold: false } }).next.spa).toBeUndefined();
    });

    it('alerts once when the fountain runs out of water', () => {
        const empty = [s('binary_sensor.eau_alerte_manque_d_eau', 'on')];
        expect(categories(detect(empty, {}).events)).toEqual(['fountain:empty']);
        expect(detect(empty, { fountain: { waterLow: true } }).events).toEqual([]);
        expect(detect([], {}).next.fountain).toBeUndefined();
    });

    it('alerts per empty feeder bac', () => {
        const states = [
            s('binary_sensor.croquettes_niveau_nourriture_reservoir_1', 'on'),
            s('binary_sensor.croquettes_niveau_nourriture_reservoir_2', 'on'),
        ];
        expect(categories(detect(states, {}).events)).toEqual(['feeder:bac1:empty', 'feeder:bac2:empty']);
        expect(detect(states, { feeder: { food1Low: true, food2Low: true } }).events).toEqual([]);
    });
});

describe('detectAlerts — humidity and temperature per area', () => {
    it('emits each humidity crossing once the area is known', () => {
        const run = (value: number, prev: AlertSnapshot['humidity']) =>
            categories(detect([], { humidity: prev }, { humidityByArea: { Salle: value } }).events);

        expect(run(20, { Salle: { belowMin: false, aboveMax: false } })).toEqual(['humidity:Salle:belowMin']);
        expect(run(50, { Salle: { belowMin: true, aboveMax: false } })).toEqual(['humidity:Salle:aboveMin']);
        expect(run(80, { Salle: { belowMin: false, aboveMax: false } })).toEqual(['humidity:Salle:aboveMax']);
        expect(run(50, { Salle: { belowMin: false, aboveMax: true } })).toEqual(['humidity:Salle:belowMax']);
        expect(run(20, {})).toEqual([]);
        // Legacy snapshot format: a boolean meant "above max"
        expect(run(50, { Salle: true })).toEqual(['humidity:Salle:belowMax']);
        expect(run(20, { Salle: false })).toEqual(['humidity:Salle:belowMin']);
    });

    it('uses the custom humidity thresholds', () => {
        const { events } = detect([], { humidity: { Salle: { belowMin: false, aboveMax: false } } }, {
            humidityByArea: { Salle: 55 },
            humidityMaxThreshold: 50,
        });
        expect(events[0].message).toBe('💧 Humidité <b>Salle</b> au-dessus de 50% (55%)');
    });

    it('emits each temperature crossing, skipping the spa area', () => {
        const run = (value: number, prev: AlertSnapshot['temperature'], area = 'Chambre') =>
            categories(detect([], { temperature: prev }, { temperatureByArea: { [area]: value } }).events);

        expect(run(12, { Chambre: { belowMin: false, aboveMax: false } })).toEqual(['temperature:Chambre:belowMin']);
        expect(run(20, { Chambre: { belowMin: true, aboveMax: false } })).toEqual(['temperature:Chambre:aboveMin']);
        expect(run(32, { Chambre: { belowMin: false, aboveMax: false } })).toEqual(['temperature:Chambre:aboveMax']);
        expect(run(20, { Chambre: { belowMin: false, aboveMax: true } })).toEqual(['temperature:Chambre:belowMax']);
        expect(run(12, {})).toEqual([]);
        expect(run(5, { 'Spa extérieur': { belowMin: false, aboveMax: false } }, 'Spa extérieur')).toEqual([]);
        expect(detect([], {}).next.temperature).toEqual({});
    });
});

describe('detectAlerts — washing machine and printer quirks', () => {
    it('finds the washing machine through French entity names', () => {
        const { events, next } = detect(
            [s('sensor.lave_linge_etat', 'on'), s('sensor.lave_linge_programme', 'finished')],
            { washingMachine: { mode: 'washing', status: 'on', error: null, isFinished: false } },
        );

        expect(categories(events)).toEqual(['washing_machine:finished']);
        expect(next.washingMachine).toMatchObject({ mode: 'finished', status: 'on', isFinished: true });
    });

    it('reports a generic washing machine error when the code is a plain "error"', () => {
        const { events } = detect([s('sensor.washing_machine_error', 'error')], { washingMachine: { error: null } });
        expect(events[0].message).toBe('⚠️ <b>Erreur lave-linge :</b> Une erreur est survenue');
    });

    it('ignores *status* sensors that are not a printer (F04)', () => {
        const { next, events } = detect([s('sensor.dishwasher_status', 'idle')], { printer: { status: 'printing' } });
        expect(next.printer).toEqual({ status: '', filename: '' });
        expect(events).toEqual([]);
    });

    it('prefers an entity carrying a printer keyword', () => {
        const { next } = detect(
            [s('sensor.dishwasher_status', 'idle'), s('sensor.p1s_print_status', 'printing'), s('sensor.p1s_gcode_filename', 'benchy.3mf')],
            {},
        );
        expect(next.printer).toEqual({ status: 'printing', filename: 'benchy.3mf' });
    });

    it('does not emit printer events when it was not printing before', () => {
        const { events } = detect([s('sensor.p1s_print_status', 'finish')], { printer: { status: 'idle' } });
        expect(events).toEqual([]);
    });
});

describe('detectAlerts — next snapshot shape', () => {
    it('freezes the persisted snapshot for a full house state', () => {
        const states = [
            s('alarm_control_panel.somfy_home_alarm_maison', 'armed_away', { last_changed: '2026-10-22T08:00:00Z' }),
            s('switch.somfy_home_alarm_siren', 'off'),
            s('camera.aarlo_salon', 'idle'),
            s('binary_sensor.aarlo_motion_salon', 'off'),
            s('climate.spa_thermostat', 'heat', { attributes: { current_temperature: 37.5 } }),
            s('binary_sensor.eau_alerte_manque_d_eau', 'off'),
            s('binary_sensor.croquettes_niveau_nourriture_reservoir_1', 'off'),
            s('sensor.washing_machine_mode', 'rinse'),
            s('sensor.p1s_print_status', 'printing'),
        ];

        const { next } = detect(states, {}, {
            lightsByArea: { Salon: true },
            humidityByArea: { Salle: 45 },
            temperatureByArea: { Chambre: 19 },
        });

        expect(next).toMatchSnapshot();
    });

    it('freezes every event (messages, keys, photos) when all categories flip at once', () => {
        const states = [
            s('alarm_control_panel.somfy_home_alarm_maison', 'triggered', { last_changed: '2026-10-22T10:00:00Z' }),
            s('switch.somfy_home_alarm_siren', 'on'),
            s('camera.aarlo_salon', 'idle'),
            s('camera.aarlo_entree', 'idle'),
            s('binary_sensor.aarlo_motion_salon', 'on'),
            s('climate.spa_thermostat', 'heat', { attributes: { current_temperature: 30 } }),
            s('binary_sensor.eau_alerte_manque_d_eau', 'on'),
            s('binary_sensor.croquettes_niveau_nourriture_reservoir_1', 'on'),
            s('binary_sensor.croquettes_niveau_nourriture_reservoir_2', 'on'),
            s('sensor.washing_machine_mode', 'finished'),
            s('sensor.washing_machine_error', 'E21 <pompe>'),
            s('sensor.p1s_print_status', 'failed'),
            s('sensor.p1s_gcode_filename', 'benchy.3mf'),
        ];
        const previous: AlertSnapshot = {
            alarm: { state: 'armed_away', lastChanged: '2026-10-22T08:00:00Z', sirenOn: false },
            lights: { Salon: true, Cuisine: false },
            humidity: { Salle: { belowMin: false, aboveMax: false }, Cave: { belowMin: false, aboveMax: false } },
            temperature: { Chambre: { belowMin: false, aboveMax: false }, Bureau: { belowMin: false, aboveMax: false } },
            spa: { belowThreshold: false },
            fountain: { waterLow: false },
            feeder: { food1Low: false, food2Low: false },
            motion: { sensors: { 'binary_sensor.aarlo_motion_salon': false } },
            washingMachine: { mode: 'rinse', status: 'on', error: null, isFinished: false },
            printer: { status: 'printing', filename: 'benchy.3mf' },
        };

        const { events } = detect(states, previous, {
            lightsByArea: { Salon: false, Cuisine: true },
            humidityByArea: { Salle: 20, Cave: 85 },
            temperatureByArea: { Chambre: 10, Bureau: 33 },
        });

        expect(events).toMatchSnapshot();
    });
});
