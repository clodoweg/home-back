/**
 * Unit tests for lib/integrations/alerts/detector.ts — focused on
 * alarm-state-change and motion-while-armed events that attach camera photos.
 */
import { describe, it, expect } from 'vitest';
import { detectAlerts } from '@/lib/integrations/alerts/detector';
import type { AlertSnapshot } from '@/lib/integrations/alerts/types';

const ALARM_ID = 'alarm_control_panel.somfy_home_alarm_maison';
const SIREN_ID = 'switch.somfy_home_alarm_siren';

interface State {
    entity_id: string;
    state: string;
    last_changed?: string;
    last_updated?: string;
    attributes?: Record<string, unknown>;
}

const baseStates = (overrides: Partial<Record<string, Partial<State>>> = {}): State[] => {
    const make = (id: string, state: string, extra: Partial<State> = {}): State => ({
        entity_id: id,
        state,
        last_changed: '2026-04-29T10:00:00Z',
        last_updated: '2026-04-29T10:00:00Z',
        attributes: {},
        ...extra,
    });
    return [
        make(ALARM_ID, overrides[ALARM_ID]?.state ?? 'disarmed', overrides[ALARM_ID] || {}),
        make(SIREN_ID, overrides[SIREN_ID]?.state ?? 'off', overrides[SIREN_ID] || {}),
        make('camera.aarlo_salon', 'idle'),
        make('camera.aarlo_entree', 'idle'),
        make(
            'binary_sensor.aarlo_motion_salon',
            overrides['binary_sensor.aarlo_motion_salon']?.state ?? 'off',
        ),
        make(
            'binary_sensor.aarlo_motion_entree',
            overrides['binary_sensor.aarlo_motion_entree']?.state ?? 'off',
        ),
    ];
};

const baseSnapshot = (overrides: Partial<AlertSnapshot> = {}): AlertSnapshot => ({
    alarm: { state: 'disarmed', sirenOn: false, sosLastUpdated: '2026-04-29T09:00:00Z' },
    lights: {},
    humidity: {},
    motion: {
        sensors: {
            'binary_sensor.aarlo_motion_salon': false,
            'binary_sensor.aarlo_motion_entree': false,
        },
    },
    ...overrides,
});

describe('detectAlerts — alarm transitions attach photoCameras', () => {
    it('disarmed → armed_away emits alarm event with photoCameras', () => {
        const { events } = detectAlerts({
            states: baseStates({ [ALARM_ID]: { state: 'armed_away' } }),
            lightsByArea: {},
            humidityByArea: {},
            previous: baseSnapshot(),
        });

        const alarmEvents = events.filter((e) => e.category === 'alarm');
        expect(alarmEvents).toHaveLength(1);
        expect(alarmEvents[0].photoCameras).toEqual(
            expect.arrayContaining(['camera.aarlo_salon', 'camera.aarlo_entree']),
        );
        expect(alarmEvents[0].message).toContain('activée');
    });

    it('armed_away → disarmed emits alarm event with photoCameras', () => {
        const { events } = detectAlerts({
            states: baseStates({ [ALARM_ID]: { state: 'disarmed' } }),
            lightsByArea: {},
            humidityByArea: {},
            previous: baseSnapshot({ alarm: { state: 'armed_away', sirenOn: false } }),
        });

        const alarmEvents = events.filter((e) => e.category === 'alarm');
        expect(alarmEvents).toHaveLength(1);
        expect(alarmEvents[0].photoCameras?.length).toBe(2);
        expect(alarmEvents[0].message).toContain('désactivée');
    });

    it('armed_away → triggered emits alarm event with photoCameras', () => {
        const { events } = detectAlerts({
            states: baseStates({ [ALARM_ID]: { state: 'triggered' } }),
            lightsByArea: {},
            humidityByArea: {},
            previous: baseSnapshot({ alarm: { state: 'armed_away', sirenOn: false } }),
        });

        const alarmEvents = events.filter((e) => e.category === 'alarm');
        expect(alarmEvents).toHaveLength(1);
        expect(alarmEvents[0].photoCameras?.length).toBe(2);
        expect(alarmEvents[0].message).toContain('déclenchée');
    });

    it('siren off → on emits alarm:siren event with photoCameras', () => {
        const { events } = detectAlerts({
            states: baseStates({
                [ALARM_ID]: { state: 'triggered' },
                [SIREN_ID]: { state: 'on' },
            }),
            lightsByArea: {},
            humidityByArea: {},
            previous: baseSnapshot({ alarm: { state: 'triggered', sirenOn: false } }),
        });

        const sirenEvent = events.find((e) => e.throttleKey === 'alarm:siren');
        expect(sirenEvent).toBeDefined();
        expect(sirenEvent?.photoCameras?.length).toBe(2);
    });

    it('no transition → no alarm event', () => {
        const { events } = detectAlerts({
            states: baseStates(),
            lightsByArea: {},
            humidityByArea: {},
            previous: baseSnapshot(),
        });
        expect(events.filter((e) => e.category === 'alarm')).toHaveLength(0);
    });
});

describe('detectAlerts — motion while armed', () => {
    it('motion off → on while armed emits motion event with all cameras', () => {
        const { events } = detectAlerts({
            states: baseStates({
                [ALARM_ID]: { state: 'armed_away' },
                'binary_sensor.aarlo_motion_salon': { state: 'on' },
            }),
            lightsByArea: {},
            humidityByArea: {},
            previous: baseSnapshot({ alarm: { state: 'armed_away', sirenOn: false } }),
        });

        const motionEvents = events.filter((e) => e.category === 'motion');
        expect(motionEvents).toHaveLength(1);
        expect(motionEvents[0].throttleKey).toBe('motion:armed');
        expect(motionEvents[0].photoCameras).toEqual(
            expect.arrayContaining(['camera.aarlo_salon', 'camera.aarlo_entree']),
        );
        expect(motionEvents[0].message).toContain('salon');
    });

    it('motion off → on while disarmed does NOT emit motion event', () => {
        const { events } = detectAlerts({
            states: baseStates({
                'binary_sensor.aarlo_motion_salon': { state: 'on' },
            }),
            lightsByArea: {},
            humidityByArea: {},
            previous: baseSnapshot(),
        });
        expect(events.filter((e) => e.category === 'motion')).toHaveLength(0);
    });

    it('motion already on (no transition) emits no motion event', () => {
        const { events } = detectAlerts({
            states: baseStates({
                [ALARM_ID]: { state: 'armed_away' },
                'binary_sensor.aarlo_motion_salon': { state: 'on' },
            }),
            lightsByArea: {},
            humidityByArea: {},
            previous: baseSnapshot({
                alarm: { state: 'armed_away', sirenOn: false },
                motion: {
                    sensors: {
                        'binary_sensor.aarlo_motion_salon': true,
                        'binary_sensor.aarlo_motion_entree': false,
                    },
                },
            }),
        });
        expect(events.filter((e) => e.category === 'motion')).toHaveLength(0);
    });

    it('persists motion sensor state in next snapshot', () => {
        const { next } = detectAlerts({
            states: baseStates({
                [ALARM_ID]: { state: 'armed_away' },
                'binary_sensor.aarlo_motion_salon': { state: 'on' },
            }),
            lightsByArea: {},
            humidityByArea: {},
            previous: baseSnapshot({ alarm: { state: 'armed_away', sirenOn: false } }),
        });
        expect(next.motion?.sensors).toEqual({
            'binary_sensor.aarlo_motion_salon': true,
            'binary_sensor.aarlo_motion_entree': false,
        });
    });
});

describe('detectAlerts — washing machine', () => {
    it('emits washingMachine finished event when transitioning from running to finished', () => {
        const states = [
            { entity_id: 'binary_sensor.washing_machine_status', state: 'off' },
            { entity_id: 'sensor.washing_machine_mode', state: 'finished' },
            { entity_id: 'sensor.washing_machine_error', state: '00' },
        ];
        const previous: AlertSnapshot = {
            washingMachine: { status: 'on', mode: 'running', error: null, isFinished: false },
        };

        const { events, next } = detectAlerts({
            states,
            lightsByArea: {},
            humidityByArea: {},
            previous,
        });

        const wmEvents = events.filter((e) => e.category === 'washingMachine');
        expect(wmEvents).toHaveLength(1);
        expect(wmEvents[0].message).toContain('Lave-linge : Cycle terminé');
        expect(next.washingMachine?.isFinished).toBe(true);
    });

    it('emits washingMachine finished event when transitioning from washing mode to off status or idle', () => {
        const states = [
            { entity_id: 'sensor.lave_linge_etape', state: 'standby' },
            { entity_id: 'binary_sensor.lave_linge_status', state: 'off' },
        ];
        const previous: AlertSnapshot = {
            washingMachine: { status: 'on', mode: 'wash', error: null, isFinished: false },
        };

        const { events } = detectAlerts({
            states,
            lightsByArea: {},
            humidityByArea: {},
            previous,
        });

        const wmEvents = events.filter((e) => e.category === 'washingMachine');
        expect(wmEvents).toHaveLength(1);
        expect(wmEvents[0].message).toContain('Lave-linge : Cycle terminé');
    });

    it('emits washingMachine error event when error code appears', () => {
        const states = [
            { entity_id: 'binary_sensor.washing_machine_status', state: 'off' },
            { entity_id: 'sensor.washing_machine_mode', state: 'error' },
            { entity_id: 'sensor.washing_machine_error', state: 'E20' },
        ];
        const previous: AlertSnapshot = {
            washingMachine: { status: 'off', mode: 'off', error: null },
        };

        const { events } = detectAlerts({
            states,
            lightsByArea: {},
            humidityByArea: {},
            previous,
        });

        const wmEvents = events.filter((e) => e.category === 'washingMachine');
        expect(wmEvents).toHaveLength(1);
        expect(wmEvents[0].message).toContain('Erreur lave-linge');
        expect(wmEvents[0].message).toContain('E20');
    });
});

describe('detectAlerts — 3D printer', () => {
    it('emits printer finished event when transitioning from printing to finish', () => {
        const states = [
            { entity_id: 'sensor.p1s_etat_de_l_impression', state: 'finish' },
            { entity_id: 'sensor.p1s_fichier_g_code', state: 'benchylos.gcode' },
        ];
        const previous: AlertSnapshot = {
            printer: { status: 'printing', filename: 'benchylos.gcode' },
        };

        const { events } = detectAlerts({
            states,
            lightsByArea: {},
            humidityByArea: {},
            previous,
        });

        const printerEvents = events.filter((e) => e.category === 'printer');
        expect(printerEvents).toHaveLength(1);
        expect(printerEvents[0].message).toContain('Impression 3D terminée');
        expect(printerEvents[0].message).toContain('benchylos.gcode');
    });

    it('emits printer finished event when transitioning from printing to idle or standby', () => {
        const states = [
            { entity_id: 'sensor.p1s_01p00c000000001_print_status', state: 'IDLE' },
            { entity_id: 'sensor.p1s_01p00c000000001_gcode_filename', state: 'part.gcode' },
        ];
        const previous: AlertSnapshot = {
            printer: { status: 'printing', filename: 'part.gcode' },
        };

        const { events } = detectAlerts({
            states,
            lightsByArea: {},
            humidityByArea: {},
            previous,
        });

        const printerEvents = events.filter((e) => e.category === 'printer');
        expect(printerEvents).toHaveLength(1);
        expect(printerEvents[0].message).toContain('Impression 3D terminée');
    });

    it('emits printer paused/error event when printing is interrupted', () => {
        const states = [
            { entity_id: 'sensor.p1s_etat_de_l_impression', state: 'pause' },
            { entity_id: 'sensor.p1s_fichier_g_code', state: 'model.gcode' },
        ];
        const previous: AlertSnapshot = {
            printer: { status: 'printing', filename: 'model.gcode' },
        };

        const { events } = detectAlerts({
            states,
            lightsByArea: {},
            humidityByArea: {},
            previous,
        });

        const printerEvents = events.filter((e) => e.category === 'printer');
        expect(printerEvents).toHaveLength(1);
        expect(printerEvents[0].message).toContain('Impression 3D mise en pause');
    });
});

describe('detectAlerts — HTML escaping of HA values (S15)', () => {
    it('escapes room names coming from Home Assistant', () => {
        const { events } = detectAlerts({
            states: baseStates(),
            lightsByArea: { '<a href="https://evil.example">Salon</a>': true },
            humidityByArea: {},
            previous: baseSnapshot({ lights: { '<a href="https://evil.example">Salon</a>': false } }),
        });

        const lightEvent = events.find((e) => e.category === 'lights');
        expect(lightEvent?.message).toContain('&lt;a href=&quot;https://evil.example&quot;&gt;Salon&lt;/a&gt;');
        expect(lightEvent?.message).not.toContain('<a ');
    });
});
