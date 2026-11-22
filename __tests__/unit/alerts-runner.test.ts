/**
 * Unit tests for runAlertCheck — detection, then one notification (bell and push) per admin and
 * alert, filtered by the admin's categories.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockPrisma } from '../setup';
import { haGet, haPost } from '@/lib/haClient';

vi.mock('@/lib/integrations/alerts/snapshot', () => ({
    loadSnapshot: vi.fn(),
    saveSnapshot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/integrations/alerts/throttle', () => ({
    shouldEmit: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/integrations/notifications', () => ({
    notifyUser: vi.fn().mockResolvedValue(true),
    pruneOldNotifications: vi.fn().mockResolvedValue(0),
}));

import { runAlertCheck, isSonoffTemperatureSensor } from '@/lib/integrations/alerts';
import { notifyUser, pruneOldNotifications } from '@/lib/integrations/notifications';
import { loadSnapshot } from '@/lib/integrations/alerts/snapshot';
import { shouldEmit } from '@/lib/integrations/alerts/throttle';

const ALARM_ID = 'alarm_control_panel.somfy_home_alarm_maison';
const SIREN_ID = 'switch.somfy_home_alarm_siren';
const SOS_ID = 'event.telecommande_bouton_4';

const haStates = (alarmState: string, motionSalon = 'off') => [
    { entity_id: ALARM_ID, state: alarmState, last_changed: '2026-04-29T10:00:00Z', attributes: {} },
    { entity_id: SIREN_ID, state: 'off', attributes: {} },
    { entity_id: SOS_ID, state: '', last_updated: '2026-04-29T09:00:00Z', attributes: {} },
    { entity_id: 'camera.aarlo_salon', state: 'idle', attributes: {} },
    { entity_id: 'camera.aarlo_entree', state: 'idle', attributes: {} },
    { entity_id: 'binary_sensor.aarlo_motion_salon', state: motionSalon, attributes: {} },
    { entity_id: 'binary_sensor.aarlo_motion_entree', state: 'off', attributes: {} },
];

const motionSnapshot = {
    sensors: {
        'binary_sensor.aarlo_motion_salon': false,
        'binary_sensor.aarlo_motion_entree': false,
    },
};

const adminUser = {
    id: 1,
    notificationPreferences: { alarm: true, motion: true },
};

const switchCalls = () => (haPost as any).mock.calls.filter((c: any[]) => c[0] === '/api/services/switch/turn_on');

describe('runAlertCheck', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (haPost as any).mockResolvedValue({ ok: true, data: '{}' });
        (mockPrisma.user.findMany as any).mockResolvedValue([adminUser]);
        (mockPrisma.user.findFirst as any).mockResolvedValue({ widgetPreferences: {} });
    });

    it('returns a failure when HA states cannot be read', async () => {
        (haGet as any).mockResolvedValue({ ok: false, data: null });

        expect(await runAlertCheck()).toEqual({ ok: false, eventsDetected: 0, adminsNotified: 0, notificationsStored: 0 });
        expect(notifyUser).not.toHaveBeenCalled();
    });

    it('notifies the alarm and siren events with a single area template and no camera capture', async () => {
        const states = haStates('triggered').map(st => (st.entity_id === SIREN_ID ? { ...st, state: 'on' } : st));
        (haGet as any).mockResolvedValue({ ok: true, data: states });
        (loadSnapshot as any).mockResolvedValue({
            alarm: { state: 'armed_away', sirenOn: false, sosLastUpdated: '2026-04-29T09:00:00Z' },
        });

        const result = await runAlertCheck();

        expect(result).toEqual({ ok: true, eventsDetected: 2, adminsNotified: 1, notificationsStored: 2 });
        expect(notifyUser).toHaveBeenCalledWith(1, expect.objectContaining({ throttleKey: 'alarm:siren' }));
        expect(switchCalls()).toHaveLength(0);
        // A single template render maps every light and sensor to its area (P06)
        const templateCalls = (haPost as any).mock.calls.filter((c: any[]) => c[0] === '/api/template');
        expect(templateCalls).toHaveLength(1);
    });

    it('notifies a motion while the alarm is armed', async () => {
        (haGet as any).mockResolvedValue({ ok: true, data: haStates('armed_away', 'on') });
        (loadSnapshot as any).mockResolvedValue({
            alarm: { state: 'armed_away', sirenOn: false, sosLastUpdated: '2026-04-29T09:00:00Z' },
            motion: motionSnapshot,
        });

        const result = await runAlertCheck();

        expect(result.eventsDetected).toBe(1);
        expect(notifyUser).toHaveBeenCalledWith(1, expect.objectContaining({ category: 'motion', message: expect.stringContaining('Mouvement') }));
    });

    it('skips event when admin disables that category', async () => {
        (haGet as any).mockResolvedValue({ ok: true, data: haStates('armed_away', 'on') });
        (loadSnapshot as any).mockResolvedValue({
            alarm: { state: 'armed_away', sirenOn: false, sosLastUpdated: '2026-04-29T09:00:00Z' },
            motion: motionSnapshot,
        });
        (mockPrisma.user.findMany as any).mockResolvedValue([
            { ...adminUser, notificationPreferences: { motion: false } },
        ]);

        const result = await runAlertCheck();

        expect(result.eventsDetected).toBe(1);
        expect(result.notificationsStored).toBe(0);
        expect(notifyUser).not.toHaveBeenCalled();
    });

    it('skips a throttled event and does not count a notification that failed to be stored', async () => {
        (haGet as any).mockResolvedValue({ ok: true, data: haStates('armed_away') });
        (loadSnapshot as any).mockResolvedValue({
            alarm: { state: 'disarmed', sirenOn: false, sosLastUpdated: '2026-04-29T09:00:00Z' },
        });
        (mockPrisma.user.findMany as any).mockResolvedValue([adminUser, { id: 2, notificationPreferences: {} }]);
        (shouldEmit as any).mockResolvedValueOnce(false);
        (notifyUser as any).mockResolvedValueOnce(false);

        const result = await runAlertCheck();

        expect(notifyUser).toHaveBeenCalledTimes(1);
        expect(notifyUser).toHaveBeenCalledWith(2, expect.objectContaining({ category: 'alarm' }));
        expect(result.notificationsStored).toBe(0);
    });

    it('stores every alert for each admin\'s bell and prunes old ones', async () => {
        (haGet as any).mockResolvedValue({ ok: true, data: haStates('armed_away') });
        (loadSnapshot as any).mockResolvedValue({
            alarm: { state: 'disarmed', sirenOn: false, sosLastUpdated: '2026-04-29T09:00:00Z' },
            motion: motionSnapshot,
        });
        (mockPrisma.user.findMany as any).mockResolvedValue([adminUser, { id: 2, notificationPreferences: {} }]);

        const result = await runAlertCheck();

        expect(mockPrisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { group: 'admin' } }));
        expect(result.notificationsStored).toBe(2);
        expect(result.adminsNotified).toBe(2);
        expect(notifyUser).toHaveBeenCalledWith(1, expect.objectContaining({ category: 'alarm' }));
        expect(notifyUser).toHaveBeenCalledWith(2, expect.objectContaining({ category: 'alarm' }));
        expect(pruneOldNotifications).toHaveBeenCalledTimes(1);
    });

    it('uses custom alert thresholds from admin preferences', async () => {
        (haGet as any).mockResolvedValue({
            ok: true,
            data: [
                { entity_id: ALARM_ID, state: 'disarmed', last_changed: '2026-04-29T10:00:00Z', attributes: {} },
                {
                    entity_id: 'climate.spa_thermostat',
                    state: 'heat',
                    attributes: { current_temperature: 35 },
                },
            ],
        });
        (loadSnapshot as any).mockResolvedValue({
            alarm: { state: 'disarmed', sirenOn: false, sosLastUpdated: '2026-04-29T09:00:00Z' },
            spa: { belowThreshold: false },
        });

        // 1. First run with custom threshold = 34. Since 35 >= 34, it should NOT be below threshold, so belowThreshold=false, no transition/alert!
        (mockPrisma.user.findFirst as any).mockResolvedValue({
            widgetPreferences: {
                notificationSpaTempThreshold: 34,
            },
        });

        let result = await runAlertCheck();
        expect(result.eventsDetected).toBe(0);

        // 2. Second run with custom threshold = 36. Since 35 < 36, it should transition to belowThreshold=true and emit an event!
        (mockPrisma.user.findFirst as any).mockResolvedValue({
            widgetPreferences: {
                notificationSpaTempThreshold: 36,
            },
        });

        result = await runAlertCheck();
        expect(result.eventsDetected).toBe(1);
        expect(notifyUser).toHaveBeenCalledTimes(1);
        expect(notifyUser).toHaveBeenCalledWith(1, expect.objectContaining({ message: expect.stringContaining('Spa sous 36°C') }));
    });

    it('detects room temperature and humidity alerts based on custom thresholds', async () => {
        // A single template maps lights and sensors to their area (P06)
        (haPost as any).mockImplementation(async (url: string, body: any, traceKey?: string) => {
            if (traceKey === 'alerts-areas') {
                return { ok: true, data: JSON.stringify({ 'sensor.temp_salon': 'Salon', 'sensor.hum_salon': 'Salon' }) };
            }
            return { ok: true, data: '{}' };
        });

        (haGet as any).mockResolvedValue({
            ok: true,
            data: [
                { entity_id: ALARM_ID, state: 'disarmed', last_changed: '2026-04-29T10:00:00Z', attributes: {} },
                {
                    entity_id: 'sensor.temp_salon',
                    state: '14.0',
                    attributes: { device_class: 'temperature' },
                },
                {
                    entity_id: 'sensor.hum_salon',
                    state: '75',
                    attributes: { device_class: 'humidity' },
                },
            ],
        });

        (loadSnapshot as any).mockResolvedValue({
            alarm: { state: 'disarmed', sirenOn: false, sosLastUpdated: '2026-04-29T09:00:00Z' },
            temperature: { Salon: { belowMin: false, aboveMax: false } },
            humidity: { Salon: { belowMin: false, aboveMax: false } },
        });

        (mockPrisma.user.findFirst as any).mockResolvedValue({
            widgetPreferences: {
                notificationTempMinThreshold: 15,
                notificationHumidityMaxThreshold: 70,
            },
        });

        (mockPrisma.user.findMany as any).mockResolvedValue([
            { ...adminUser, notificationPreferences: { alarm: true, motion: true, temperature: true, humidity: true } },
        ]);

        const result = await runAlertCheck();
        expect(result.eventsDetected).toBe(2);
        expect(notifyUser).toHaveBeenCalledTimes(2);
        expect(notifyUser).toHaveBeenCalledWith(1, expect.objectContaining({ message: expect.stringContaining('Température <b>Salon</b> sous 15°C') }));
        expect(notifyUser).toHaveBeenCalledWith(1, expect.objectContaining({ message: expect.stringContaining('Humidité <b>Salon</b> au-dessus de 70%') }));
    });

    describe('isSonoffTemperatureSensor', () => {
        it('finds an English _humidity twin (F05: it was never tested)', () => {
            const humidity = new Set(['sensor.bureau_humidity']);
            expect(isSonoffTemperatureSensor({ entity_id: 'sensor.bureau_temperature' }, humidity)).toBe(true);
            expect(isSonoffTemperatureSensor({ entity_id: 'sensor.bureau_temperature' }, new Set())).toBe(false);
        });

        it('identifies Sonoff sensors by entity_id prefix or humidity pair and ignores non-Sonoff sensors', () => {
            const humiditySet = new Set(['sensor.temperature_chambre_humidite', 'sensor.hum_salon']);

            expect(isSonoffTemperatureSensor({ entity_id: 'sensor.temperature_chambre_temperature' }, humiditySet)).toBe(true);
            expect(isSonoffTemperatureSensor({ entity_id: 'sensor.temp_salon' }, humiditySet)).toBe(true);
            expect(isSonoffTemperatureSensor({ entity_id: 'sensor.temperature_chambre_batterie' }, humiditySet)).toBe(false);
            expect(isSonoffTemperatureSensor({ entity_id: 'sensor.mouvement_etage_temperature' }, humiditySet)).toBe(false);
            expect(isSonoffTemperatureSensor({ entity_id: 'sensor.sirene_exterieure_temperature' }, humiditySet)).toBe(false);
            expect(isSonoffTemperatureSensor({ entity_id: 'sensor.nas_drive_1_temperature' }, humiditySet)).toBe(false);
        });
    });
});
