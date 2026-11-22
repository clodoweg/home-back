/**
 * Alert detector — compares the current HA/Petkit state to the previous snapshot
 * and emits AlertEvent entries for crossed transitions.
 *
 * One detector per category; each returns its events and its part of the next snapshot.
 * Entity IDs are centralized here so they can be swapped via env vars if needed.
 */
import type { AlertCategory, AlertEvent, AlertSnapshot } from './types';
import { escapeHtml } from './format';
import type { HAState } from '@/lib/haClient';

const ALARM_ENTITY = 'alarm_control_panel.somfy_home_alarm_maison';
const ALARM_SIREN_ENTITY = 'switch.somfy_home_alarm_siren';
const ALARM_SOS_ENTITY = process.env.ALARM_SOS_ENTITY || '';
const SPA_CLIMATE_ENTITY = 'climate.spa_thermostat';
const DEFAULT_SPA_TEMP_THRESHOLD = 37;
const DEFAULT_TEMP_MIN_THRESHOLD = 15;
const DEFAULT_TEMP_MAX_THRESHOLD = 30;
const DEFAULT_HUMIDITY_MIN_THRESHOLD = 30;
const DEFAULT_HUMIDITY_MAX_THRESHOLD = 70;
const FEEDER_FOOD1_ENTITY = 'binary_sensor.croquettes_niveau_nourriture_reservoir_1';
const FEEDER_FOOD2_ENTITY = 'binary_sensor.croquettes_niveau_nourriture_reservoir_2';
const FOUNTAIN_WATER_ENTITY = 'binary_sensor.eau_alerte_manque_d_eau';

const ARMED_STATES = new Set(['armed_away', 'armed_home', 'armed_night']);

function alarmStateLabel(state: string): string {
    switch (state) {
        case 'disarmed':
            return 'désactivée';
        case 'armed_away':
        case 'armed_home':
            return 'activée';
        case 'armed_night':
            return 'activée (nuit)';
        case 'triggered':
            return 'déclenchée';
        case 'arming':
            return "en cours d'activation";
        case 'disarming':
            return 'en cours de désactivation';
        default:
            return escapeHtml(state);
    }
}

interface DetectArgs {
    states: HAState[];
    lightsByArea: Record<string, boolean>;
    humidityByArea: Record<string, number>; // area → current humidity %
    temperatureByArea?: Record<string, number>; // area → current temperature °C
    previous: AlertSnapshot;
    spaTempThreshold?: number;
    tempMinThreshold?: number;
    tempMaxThreshold?: number;
    humidityMinThreshold?: number;
    humidityMaxThreshold?: number;
}

export interface DetectResult {
    events: AlertEvent[];
    next: AlertSnapshot;
}

/** Shared view of the current states, built once per run. */
interface DetectContext {
    states: HAState[];
    byId: Map<string, HAState>;
    /** Arlo cameras: motion alerts only exist when the house has some. */
    arloCameras: string[];
}

/** Result of one category detector. */
interface CategoryResult<K extends keyof AlertSnapshot> {
    events: AlertEvent[];
    next: AlertSnapshot[K];
}

function detectAlarm(ctx: DetectContext, previous: AlertSnapshot['alarm']): CategoryResult<'alarm'> {
    const events: AlertEvent[] = [];
    const alarm = ctx.byId.get(ALARM_ENTITY);
    const alarmState = alarm?.state;
    const alarmLastChanged = alarm?.last_changed;
    const sirenOn = ctx.byId.get(ALARM_SIREN_ENTITY)?.state === 'on';
    const sosLastUpdated = ctx.byId.get(ALARM_SOS_ENTITY)?.last_updated;

    const stateChanged = previous?.state && alarmState && alarmState !== previous.state;
    // Catch missed transitions: same final state but last_changed moved (e.g. disarmed→armed→disarmed→armed between two runs)
    const timestampMoved =
        alarmLastChanged && previous?.lastChanged && alarmLastChanged !== previous.lastChanged && alarmState === previous.state;

    if (stateChanged) {
        events.push({
            category: 'alarm',
            throttleKey: `alarm:state:${previous?.state}:${alarmState}`,
            message: `🛡️ <b>Alarme ${alarmStateLabel(alarmState as string)}</b>`,
        });
    } else if (timestampMoved && alarmState) {
        events.push({
            category: 'alarm',
            throttleKey: `alarm:state:transition:${alarmLastChanged}`,
            message: `🛡️ <b>Alarme ${alarmStateLabel(alarmState)}</b> (transition manquée)`,
        });
    }

    if (sirenOn && !previous?.sirenOn) {
        events.push({
            category: 'alarm',
            throttleKey: 'alarm:siren',
            message: '🚨 <b>Sirène déclenchée !</b>',
        });
    }

    if (sosLastUpdated && previous?.sosLastUpdated && sosLastUpdated !== previous.sosLastUpdated) {
        events.push({ category: 'alarm', throttleKey: 'alarm:sos', message: '🆘 <b>Bouton SOS pressé !</b>' });
    }

    return { events, next: { state: alarmState, lastChanged: alarmLastChanged, sirenOn, sosLastUpdated } };
}

function detectLights(lightsByArea: Record<string, boolean>, previous: AlertSnapshot['lights']): CategoryResult<'lights'> {
    const events: AlertEvent[] = [];
    const prevLights = previous || {};
    for (const [area, isOn] of Object.entries(lightsByArea)) {
        const prevOn = prevLights[area];
        if (prevOn === undefined || isOn === prevOn) continue; // first run for this area, or no change
        events.push({
            category: 'lights',
            throttleKey: `lights:${area}:${isOn ? 'on' : 'off'}`,
            message: isOn ? `💡 Lumières <b>${escapeHtml(area)}</b> allumées` : `🌙 Lumières <b>${escapeHtml(area)}</b> éteintes`,
        });
    }
    return { events, next: lightsByArea };
}

function detectSpa(ctx: DetectContext, previous: AlertSnapshot['spa'], threshold: number): CategoryResult<'spa'> | null {
    const currentTemp = ctx.byId.get(SPA_CLIMATE_ENTITY)?.attributes?.current_temperature;
    // An unavailable climate entity reports null: no reading, no transition
    if (typeof currentTemp !== 'number') return null;

    const events: AlertEvent[] = [];
    const belowThreshold = currentTemp < threshold;
    if (belowThreshold && previous?.belowThreshold === false) {
        events.push({
            category: 'spa',
            throttleKey: `spa:below${threshold}`,
            message: `🛁 <b>Spa sous ${threshold}°C</b> (actuellement ${currentTemp.toFixed(1)}°C)`,
        });
    }
    if (!belowThreshold && previous?.belowThreshold === true) {
        events.push({
            category: 'spa',
            throttleKey: `spa:above${threshold}`,
            message: `✅ <b>Spa à température</b> (actuellement ${currentTemp.toFixed(1)}°C)`,
        });
    }
    return { events, next: { belowThreshold } };
}

function detectFountain(ctx: DetectContext, previous: AlertSnapshot['fountain']): CategoryResult<'fountain'> | null {
    const fountain = ctx.byId.get(FOUNTAIN_WATER_ENTITY);
    if (!fountain) return null;

    const waterLow = fountain.state === 'on';
    const events: AlertEvent[] = waterLow && !previous?.waterLow
        ? [{ category: 'fountain', throttleKey: 'fountain:empty', message: "💧 <b>Plus d'eau dans la fontaine !</b>" }]
        : [];
    return { events, next: { waterLow } };
}

function detectFeeder(ctx: DetectContext, previous: AlertSnapshot['feeder']): CategoryResult<'feeder'> {
    const food1Low = ctx.byId.get(FEEDER_FOOD1_ENTITY)?.state === 'on';
    const food2Low = ctx.byId.get(FEEDER_FOOD2_ENTITY)?.state === 'on';
    const events: AlertEvent[] = [];
    if (food1Low && !previous?.food1Low) {
        events.push({ category: 'feeder', throttleKey: 'feeder:bac1:empty', message: '🐾 <b>Bac 1 de croquettes vide</b>' });
    }
    if (food2Low && !previous?.food2Low) {
        events.push({ category: 'feeder', throttleKey: 'feeder:bac2:empty', message: '🐾 <b>Bac 2 de croquettes vide</b>' });
    }
    return { events, next: { food1Low, food2Low } };
}

/**
 * When the alarm is in any armed state and an aarlo motion sensor flips off→on, emits one
 * motion event listing the cameras to snapshot.
 */
function detectMotion(ctx: DetectContext, previous: AlertSnapshot['motion'], alarmState: string | undefined): CategoryResult<'motion'> {
    const prevSensors = previous?.sensors || {};
    const sensors: Record<string, boolean> = {};
    const newlyTriggered: string[] = [];

    for (const sensor of ctx.states.filter(s => s.entity_id.startsWith('binary_sensor.aarlo_motion_'))) {
        const isOn = sensor.state === 'on';
        sensors[sensor.entity_id] = isOn;
        if (isOn && prevSensors[sensor.entity_id] === false) newlyTriggered.push(sensor.entity_id);
    }

    const events: AlertEvent[] = [];
    const alarmArmed = alarmState ? ARMED_STATES.has(alarmState) : false;
    if (alarmArmed && newlyTriggered.length > 0 && ctx.arloCameras.length > 0) {
        const triggeredNames = newlyTriggered.map(id => escapeHtml(id.replace('binary_sensor.aarlo_motion_', ''))).join(', ');
        events.push({
            category: 'motion',
            throttleKey: 'motion:armed',
            message: `🚨 <b>Mouvement détecté</b> (${triggeredNames}) — alarme activée`,
        });
    }
    return { events, next: { sensors } };
}

type ThresholdState = { belowMin: boolean; aboveMax: boolean };

interface AreaThresholdOptions {
    category: Extract<AlertCategory, 'humidity' | 'temperature'>;
    label: string;
    unit: string;
    belowMinIcon: string;
    aboveMaxIcon: string;
    formatValue: (value: number) => string;
    min: number;
    max: number;
    /** Old humidity snapshots stored a boolean meaning "above max". */
    acceptLegacyBoolean?: boolean;
}

/**
 * Generic min/max crossing detector for a measure grouped by area (humidity, temperature).
 * An area only alerts once its previous state is known.
 *
 * @param valuesByArea Current value per area.
 * @param previous Previous state per area.
 * @param options Category, wording and thresholds.
 * @returns The crossing events and the new state per area.
 */
export function detectAreaThresholds(
    valuesByArea: Record<string, number>,
    previous: Record<string, ThresholdState | boolean> | undefined,
    options: AreaThresholdOptions,
): { events: AlertEvent[]; next: Record<string, ThresholdState> } {
    const { category, label, unit, belowMinIcon, aboveMaxIcon, formatValue, min, max, acceptLegacyBoolean } = options;
    const events: AlertEvent[] = [];
    const next: Record<string, ThresholdState> = {};

    for (const [area, value] of Object.entries(valuesByArea)) {
        const belowMin = value < min;
        const aboveMax = value > max;
        next[area] = { belowMin, aboveMax };

        const prev = previous?.[area];
        if (prev === undefined || prev === null) continue;
        if (typeof prev === 'boolean' && !acceptLegacyBoolean) continue;
        const prevBelow = typeof prev === 'boolean' ? false : prev.belowMin;
        const prevAbove = typeof prev === 'boolean' ? prev : prev.aboveMax;
        if (prevBelow === undefined || prevAbove === undefined) continue;

        const name = `${label} <b>${escapeHtml(area)}</b>`;
        const shown = `(${formatValue(value)}${unit})`;
        if (belowMin && !prevBelow) {
            events.push({ category, throttleKey: `${category}:${area}:belowMin`, message: `${belowMinIcon} ${name} sous ${min}${unit} ${shown}` });
        }
        if (!belowMin && prevBelow) {
            events.push({ category, throttleKey: `${category}:${area}:aboveMin`, message: `✅ ${name} revenue au-dessus de ${min}${unit} ${shown}` });
        }
        if (aboveMax && !prevAbove) {
            events.push({ category, throttleKey: `${category}:${area}:aboveMax`, message: `${aboveMaxIcon} ${name} au-dessus de ${max}${unit} ${shown}` });
        }
        if (!aboveMax && prevAbove) {
            events.push({ category, throttleKey: `${category}:${area}:belowMax`, message: `✅ ${name} revenue sous ${max}${unit} ${shown}` });
        }
    }
    return { events, next };
}

function detectWashingMachine(ctx: DetectContext, previous: AlertSnapshot['washingMachine']): CategoryResult<'washingMachine'> {
    const isWmEntity = (id: string) => id.includes('washing_machine') || id.includes('lave_linge') || id.includes('lavelinge');
    const findWm = (preferredId: string, keywords: string[]) =>
        ctx.byId.get(preferredId) || ctx.states.find(s => isWmEntity(s.entity_id) && keywords.some(k => s.entity_id.includes(k)));

    const wmStatus = findWm('binary_sensor.washing_machine_status', ['status', 'state', 'etat']);
    const wmMode = findWm('sensor.washing_machine_mode', ['mode', 'phase', 'cycle', 'etape', 'programme']);
    const wmError = findWm('sensor.washing_machine_error', ['error', 'erreur', 'fault']);

    const rawMode = wmMode?.state?.trim() || '';
    const mode = rawMode.toLowerCase();
    const rawStatus = wmStatus?.state?.trim() || '';
    const status = rawStatus.toLowerCase();
    const rawError = wmError?.state?.trim() || '';

    const isError =
        (rawError !== '' && !['0', '00', 'no_error', 'none', 'ok', 'normal', 'unavailable', 'unknown'].includes(rawError.toLowerCase())) ||
        ['error', 'fault', 'erreur'].includes(mode);
    const finishedStates = ['finish', 'finished', 'end', 'completed', 'complete', 'done', '09', 'termine', 'terminé', 'stop', 'stopped', 'standby', 'off', 'idle', 'none', '0'];
    const isFinished = finishedStates.includes(mode) || (status === 'off' && mode !== 'on');

    const prev = previous || {};
    const runningStates = ['run', 'running', 'wash', 'washing', 'main_wash', 'prewash', 'pre_wash', 'rinse', 'rinsing', 'spin', 'spinning', 'dry', 'drying', 'on', 'active', 'working', 'operation', 'in_use', 'delicate', 'cotton', 'synthetics', 'wool', 'quick_wash', 'eco', 'agitate'];
    const wasRunning = prev.status === 'on' || runningStates.includes((prev.mode || '').toLowerCase());

    const events: AlertEvent[] = [];
    if (wasRunning && (isFinished || (status === 'off' && !isError && prev.isFinished !== true))) {
        events.push({ category: 'washingMachine', throttleKey: 'washing_machine:finished', message: '🧺 <b>Lave-linge : Cycle terminé !</b>' });
    }
    if (isError && !prev.error) {
        const errorMsg = rawError && !['error', 'fault', 'erreur'].includes(rawError.toLowerCase()) ? rawError : 'Une erreur est survenue';
        events.push({
            category: 'washingMachine',
            throttleKey: `washing_machine:error:${errorMsg}`,
            message: `⚠️ <b>Erreur lave-linge :</b> ${escapeHtml(errorMsg)}`,
        });
    }

    return { events, next: { mode: rawMode, status: rawStatus, error: isError ? rawError : null, isFinished } };
}

const PRINTER_KEYWORDS = ['p1s', 'bambu', 'x1c', 'p1p', 'a1', 'printer', '3d', 'impression'];
const PRINTER_STATUS_SUBSTRINGS = ['print_status', 'print_state', 'current_stage', 'print_stage', 'etat_de_l_impression', 'etape_actuelle', 'stage', 'status'];
const PRINTER_FILENAME_SUBSTRINGS = ['gcode_filename', 'subtask_name', 'gcode_file', 'print_file', 'fichier_g_code', 'nom_de_la_tache', 'filename'];

/**
 * Finds the printer sensor whose id contains one of the given substrings. The id must also
 * carry a printer keyword: generic `*_status` sensors (dishwasher, washing machine…) used
 * to be picked as a fallback and raised false printer alerts.
 */
function findPrinterSensor(states: HAState[], substrings: string[]): HAState | undefined {
    return states.find(e => {
        const id = e.entity_id.toLowerCase();
        return id.startsWith('sensor.')
            && substrings.some(sub => id.includes(sub))
            && PRINTER_KEYWORDS.some(kw => id.includes(kw));
    });
}

function detectPrinter(ctx: DetectContext, previous: AlertSnapshot['printer']): CategoryResult<'printer'> {
    const status = findPrinterSensor(ctx.states, PRINTER_STATUS_SUBSTRINGS)?.state?.trim() || '';
    const normStatus = status.toLowerCase();
    const filename = findPrinterSensor(ctx.states, PRINTER_FILENAME_SUBSTRINGS)?.state?.trim() || '';

    const isFinished = ['finish', 'finished', 'success', 'completed', 'complete', 'done', 'idle', 'standby', 'off', '0'].includes(normStatus);
    const isError = ['error', 'failed', 'failed_print', 'offline', 'fault', 'cancelled', 'canceled'].includes(normStatus);
    const isPaused = ['pause', 'paused', 'user_wait', 'pause_for_user'].includes(normStatus);

    const printingStates = ['printing', 'running', 'preparing', 'heating', 'calibrating', 'slicing', 'bed_leveling', 'leveling', 'cleaning', 'building', 'on', 'active', 'work', 'working', 'print'];
    const wasPrinting = printingStates.includes((previous?.status || '').toLowerCase());
    const fileDetail = filename ? ` (<i>${escapeHtml(filename)}</i>)` : '';

    const events: AlertEvent[] = [];
    if (wasPrinting && isFinished && !isError && !isPaused) {
        events.push({ category: 'printer', throttleKey: 'printer:finished', message: `🖨️ <b>Impression 3D terminée !</b>${fileDetail}` });
    }
    if (wasPrinting && (isError || isPaused)) {
        events.push({
            category: 'printer',
            throttleKey: `printer:${isPaused ? 'paused' : 'error'}`,
            message: `⚠️ <b>Impression 3D ${isPaused ? 'mise en pause' : 'en erreur'} !</b>${fileDetail}`,
        });
    }

    return { events, next: { status, filename } };
}

/**
 * Détecte les nouvelles alertes en comparant l'état actuel de la maison
 * avec le précédent snapshot enregistré.
 *
 * @param {DetectArgs} args Les arguments contenant l'état actuel et le snapshot précédent.
 * @returns {DetectResult} Les événements d'alertes détectés et le prochain snapshot.
 */
export function detectAlerts(args: DetectArgs): DetectResult {
    const { states, previous } = args;
    const ctx: DetectContext = {
        states,
        byId: new Map(states.map(s => [s.entity_id, s])),
        arloCameras: states.filter(s => s.entity_id.startsWith('camera.aarlo_')).map(s => s.entity_id),
    };

    const next: AlertSnapshot = {};
    const events: AlertEvent[] = [];

    const alarm = detectAlarm(ctx, previous.alarm);
    next.alarm = alarm.next;
    events.push(...alarm.events);

    const lights = detectLights(args.lightsByArea, previous.lights);
    next.lights = lights.next;
    events.push(...lights.events);

    const spa = detectSpa(ctx, previous.spa, args.spaTempThreshold ?? DEFAULT_SPA_TEMP_THRESHOLD);
    if (spa) {
        next.spa = spa.next;
        events.push(...spa.events);
    }

    const fountain = detectFountain(ctx, previous.fountain);
    if (fountain) {
        next.fountain = fountain.next;
        events.push(...fountain.events);
    }

    const feeder = detectFeeder(ctx, previous.feeder);
    next.feeder = feeder.next;
    events.push(...feeder.events);

    const motion = detectMotion(ctx, previous.motion, alarm.next?.state);
    next.motion = motion.next;
    events.push(...motion.events);

    const humidity = detectAreaThresholds(args.humidityByArea, previous.humidity, {
        category: 'humidity',
        label: 'Humidité',
        unit: '%',
        belowMinIcon: '💧',
        aboveMaxIcon: '💧',
        formatValue: value => String(Math.round(value)),
        min: args.humidityMinThreshold ?? DEFAULT_HUMIDITY_MIN_THRESHOLD,
        max: args.humidityMaxThreshold ?? DEFAULT_HUMIDITY_MAX_THRESHOLD,
        acceptLegacyBoolean: true,
    });
    next.humidity = humidity.next;
    events.push(...humidity.events);

    // The spa area is skipped: the spa climate alert already covers it
    const temperatureByArea = Object.fromEntries(
        Object.entries(args.temperatureByArea ?? {}).filter(([area]) => !area.toLowerCase().includes('spa')),
    );
    const temperature = detectAreaThresholds(temperatureByArea, previous.temperature, {
        category: 'temperature',
        label: 'Température',
        unit: '°C',
        belowMinIcon: '🌡️',
        aboveMaxIcon: '🔥',
        formatValue: value => value.toFixed(1),
        min: args.tempMinThreshold ?? DEFAULT_TEMP_MIN_THRESHOLD,
        max: args.tempMaxThreshold ?? DEFAULT_TEMP_MAX_THRESHOLD,
    });
    next.temperature = temperature.next;
    events.push(...temperature.events);

    const washingMachine = detectWashingMachine(ctx, previous.washingMachine);
    next.washingMachine = washingMachine.next;
    events.push(...washingMachine.events);

    const printer = detectPrinter(ctx, previous.printer);
    next.printer = printer.next;
    events.push(...printer.events);

    return { events, next };
}
