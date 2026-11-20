/**
 * Unit tests for runAlertCheck — verifies that events with photoCameras
 * trigger snapshot switches, fetch images, and dispatch via sendMediaGroup.
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

vi.mock('@/lib/integrations/telegram', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/integrations/telegram')>()),
    sendTelegramMessage: vi.fn().mockResolvedValue(true),
    sendTelegramMediaGroup: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/integrations/notifications', () => ({
    notifyUser: vi.fn().mockResolvedValue(true),
    pruneOldNotifications: vi.fn().mockResolvedValue(0),
}));

import { runAlertCheck, isSonoffTemperatureSensor } from '@/lib/integrations/alerts';
import { notifyUser, pruneOldNotifications } from '@/lib/integrations/notifications';
import { loadSnapshot } from '@/lib/integrations/alerts/snapshot';
import { sendTelegramMessage, sendTelegramMediaGroup } from '@/lib/integrations/telegram';

const ALARM_ID = 'alarm_control_panel.somfy_home_alarm_maison';
const SIREN_ID = 'switch.somfy_home_alarm_siren';
const SOS_ID = 'event.telecommande_bouton_4';

const haStates = (alarmState: string, motionSalon = 'off') => [
    { entity_id: ALARM_ID, state: alarmState, last_changed: '2026-04-29T10:00:00Z', attributes: {} },
    { entity_id: SIREN_ID, state: 'off', attributes: {} },
    { entity_id: SOS_ID, state: '', last_updated: '2026-04-29T09:00:00Z', attributes: {} },
    { entity_id: 'camera.aarlo_salon', state: 'idle', attributes: {} },
    { entity_id: 'camera.aarlo_entree', state: 'idle', attributes: {} },
    {
        entity_id: 'binary_sensor.aarlo_motion_salon',
        state: motionSalon,
        attributes: {},
    },
    {
        entity_id: 'binary_sensor.aarlo_motion_entree',
        state: 'off',
        attributes: {},
    },
];

const adminUser = {
    id: 1,
    telegramChatId: 'chat-1',
    notificationPreferences: { alarm: true, motion: true },
};

describe('runAlertCheck — photoCameras dispatch', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // captureCameraPhotos waits 4s for Arlo — fast-forward via fake timers per test
        vi.useFakeTimers({ shouldAdvanceTime: true });

        // Stub fetch for camera_proxy with valid image bytes
        global.fetch = vi.fn(async () => new Response(new Uint8Array(8), { headers: { 'content-type': 'image/jpeg' } })) as unknown as typeof fetch;

        (haPost as any).mockResolvedValue({ ok: true, data: '{}' });
        (mockPrisma.user.findMany as any).mockResolvedValue([adminUser]);
        (mockPrisma.user.findFirst as any).mockResolvedValue({ widgetPreferences: {} });

        process.env.TELEGRAM_BOT_TOKEN = 'fake-token';
    });

    it('captures each camera once when alarm and siren events share the cameras (P07)', async () => {
        const states = haStates('triggered').map(st => (st.entity_id === SIREN_ID ? { ...st, state: 'on' } : st));
        (haGet as any).mockResolvedValue({ ok: true, data: states });
        (loadSnapshot as any).mockResolvedValue({
            alarm: { state: 'armed_away', sirenOn: false, sosLastUpdated: '2026-04-29T09:00:00Z' },
        });

        const promise = runAlertCheck();
        await vi.advanceTimersByTimeAsync(4000);
        const result = await promise;

        expect(result.eventsDetected).toBe(2);
        const switchCalls = (haPost as any).mock.calls.filter((c: any[]) => c[0] === '/api/services/switch/turn_on');
        expect(switchCalls).toHaveLength(2);
        expect(sendTelegramMediaGroup).toHaveBeenCalledTimes(2);
        // A single template render maps every light and sensor to its area (P06)
        const templateCalls = (haPost as any).mock.calls.filter((c: any[]) => c[0] === '/api/template');
        expect(templateCalls).toHaveLength(1);
    });

    it('alarm transition disarmed→armed_away triggers snapshots and sendMediaGroup', async () => {
        (haGet as any).mockResolvedValue({ ok: true, data: haStates('armed_away') });
        (loadSnapshot as any).mockResolvedValue({
            alarm: { state: 'disarmed', sirenOn: false, sosLastUpdated: '2026-04-29T09:00:00Z' },
            motion: {
                sensors: {
                    'binary_sensor.aarlo_motion_salon': false,
                    'binary_sensor.aarlo_motion_entree': false,
                },
            },
        });

        const promise = runAlertCheck();
        await vi.advanceTimersByTimeAsync(4000);
        const result = await promise;

        expect(result.eventsDetected).toBe(1);
        expect(result.messagesSent).toBe(1);

        // Both snapshot switches were turned on
        const switchCalls = (haPost as any).mock.calls.filter(
            (c: any[]) => c[0] === '/api/services/switch/turn_on',
        );
        const switchedIds = switchCalls.map((c: any[]) => c[1].entity_id);
        expect(switchedIds).toEqual(
            expect.arrayContaining([
                'switch.aarlo_snapshot_salon',
                'switch.aarlo_snapshot_entree',
            ]),
        );

        // sendMediaGroup called with two photos, not sendTelegramMessage
        expect(sendTelegramMediaGroup).toHaveBeenCalledTimes(1);
        expect(sendTelegramMessage).not.toHaveBeenCalled();
        const [chatId, photos, caption] = (sendTelegramMediaGroup as any).mock.calls[0];
        expect(chatId).toBe('chat-1');
        expect(photos).toHaveLength(2);
        expect(caption).toContain('Alarme');
    });

    it('motion-while-armed triggers sendMediaGroup with both camera photos', async () => {
        (haGet as any).mockResolvedValue({ ok: true, data: haStates('armed_away', 'on') });
        (loadSnapshot as any).mockResolvedValue({
            alarm: { state: 'armed_away', sirenOn: false, sosLastUpdated: '2026-04-29T09:00:00Z' },
            motion: {
                sensors: {
                    'binary_sensor.aarlo_motion_salon': false,
                    'binary_sensor.aarlo_motion_entree': false,
                },
            },
        });

        const promise = runAlertCheck();
        await vi.advanceTimersByTimeAsync(4000);
        const result = await promise;

        expect(result.eventsDetected).toBe(1);
        expect(sendTelegramMediaGroup).toHaveBeenCalledTimes(1);
        const [, photos, caption] = (sendTelegramMediaGroup as any).mock.calls[0];
        expect(photos).toHaveLength(2);
        expect(caption).toContain('Mouvement');
    });

    it('skips event when admin disables that category', async () => {
        (haGet as any).mockResolvedValue({ ok: true, data: haStates('armed_away', 'on') });
        (loadSnapshot as any).mockResolvedValue({
            alarm: { state: 'armed_away', sirenOn: false, sosLastUpdated: '2026-04-29T09:00:00Z' },
            motion: {
                sensors: {
                    'binary_sensor.aarlo_motion_salon': false,
                    'binary_sensor.aarlo_motion_entree': false,
                },
            },
        });
        (mockPrisma.user.findMany as any).mockResolvedValue([
            { ...adminUser, notificationPreferences: { motion: false } },
        ]);

        const promise = runAlertCheck();
        await vi.advanceTimersByTimeAsync(4000);
        const result = await promise;

        expect(result.eventsDetected).toBe(1);
        expect(result.messagesSent).toBe(0);
        expect(sendTelegramMediaGroup).not.toHaveBeenCalled();
        expect(sendTelegramMessage).not.toHaveBeenCalled();
    });

    it('falls back to sendMessage when camera proxy returns no bytes', async () => {
        (haGet as any).mockResolvedValue({ ok: true, data: haStates('armed_away') });
        (loadSnapshot as any).mockResolvedValue({
            alarm: { state: 'disarmed', sirenOn: false, sosLastUpdated: '2026-04-29T09:00:00Z' },
            motion: {
                sensors: {
                    'binary_sensor.aarlo_motion_salon': false,
                    'binary_sensor.aarlo_motion_entree': false,
                },
            },
        });
        global.fetch = vi.fn(async () => new Response(new Uint8Array(0), { headers: { 'content-type': 'image/jpeg' } })) as unknown as typeof fetch;

        const promise = runAlertCheck();
        await vi.advanceTimersByTimeAsync(4000);
        const result = await promise;

        expect(result.eventsDetected).toBe(1);
        expect(result.messagesSent).toBe(1);
        expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
        expect(sendTelegramMediaGroup).not.toHaveBeenCalled();
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
        expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
        expect(sendTelegramMessage).toHaveBeenCalledWith('chat-1', expect.stringContaining('Spa sous 36°C'));
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
        expect(sendTelegramMessage).toHaveBeenCalledTimes(2);
        expect(sendTelegramMessage).toHaveBeenCalledWith('chat-1', expect.stringContaining('Température <b>Salon</b> sous 15°C'));
        expect(sendTelegramMessage).toHaveBeenCalledWith('chat-1', expect.stringContaining('Humidité <b>Salon</b> au-dessus de 70%'));
    });

    it('stores every alert for each admin\'s bell, Telegram chat or not, and prunes old ones', async () => {
        (haGet as any).mockResolvedValue({ ok: true, data: haStates('armed_away') });
        (loadSnapshot as any).mockResolvedValue({
            alarm: { state: 'disarmed', sirenOn: false, sosLastUpdated: '2026-04-29T09:00:00Z' },
            motion: {
                sensors: {
                    'binary_sensor.aarlo_motion_salon': false,
                    'binary_sensor.aarlo_motion_entree': false,
                },
            },
        });
        (mockPrisma.user.findMany as any).mockResolvedValue([
            adminUser,
            { id: 2, telegramChatId: null, notificationPreferences: {} },
        ]);

        const promise = runAlertCheck();
        await vi.advanceTimersByTimeAsync(4000);
        const result = await promise;

        expect(mockPrisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { group: 'admin' } }));
        expect(result.notificationsStored).toBe(2);
        expect(notifyUser).toHaveBeenCalledWith(1, expect.objectContaining({ category: 'alarm' }));
        expect(notifyUser).toHaveBeenCalledWith(2, expect.objectContaining({ category: 'alarm' }));
        // Telegram only for the linked chat.
        expect(result.messagesSent).toBe(1);
        expect(pruneOldNotifications).toHaveBeenCalledTimes(1);
    });

    it('takes no camera photo when no admin has a Telegram chat', async () => {
        (haGet as any).mockResolvedValue({ ok: true, data: haStates('armed_away') });
        (loadSnapshot as any).mockResolvedValue({
            alarm: { state: 'disarmed', sirenOn: false, sosLastUpdated: '2026-04-29T09:00:00Z' },
        });
        (mockPrisma.user.findMany as any).mockResolvedValue([
            { id: 2, telegramChatId: null, notificationPreferences: {} },
        ]);

        const result = await runAlertCheck();

        expect(result.notificationsStored).toBe(1);
        expect(result.messagesSent).toBe(0);
        const switchCalls = (haPost as any).mock.calls.filter((c: any[]) => c[0] === '/api/services/switch/turn_on');
        expect(switchCalls).toHaveLength(0);
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
