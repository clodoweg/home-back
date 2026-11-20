import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockPrisma } from '../setup';
import { mockHaFetch, resetHAMocks } from '../helpers/mock-ha';
import { buildUsageRules, type UsageRule } from '@/lib/integrations/daily-usage/rules';
import { computeUsage } from '@/lib/integrations/daily-usage/compute';
import {
    daysToCompute,
    getDailyUsage,
    parisDayBounds,
    syncDailyUsage,
    syncDailyUsageIfDue,
    MAX_CATCH_UP_DAYS,
} from '@/lib/integrations/daily-usage/service';

vi.mock('@/lib/ha-states-cache', () => ({ getCachedStates: vi.fn() }));
const { getCachedStates } = await import('@/lib/ha-states-cache');

const H = 60 * 60 * 1000;
const at = (iso: string) => Date.parse(iso);
const state = (entity_id: string, value = 'off') => ({ entity_id, state: value });

describe('buildUsageRules', () => {
    it('builds the rules of the entities present in HA', () => {
        const rules = buildUsageRules([
            state('light.salon'),
            state('light.p1s_chamber_light'),
            state('alarm_control_panel.maison', 'disarmed'),
            state('binary_sensor.aarlo_motion_jardin'),
            state('sensor.p1s_01p00a_etat_de_l_impression', 'idle'),
            state('climate.spa_thermostat', 'heat'),
            state('switch.spa_power'),
            state('switch.prise_pc'),
            state('binary_sensor.washing_machine_status'),
            state('binary_sensor.eau_pet_drinking'),
            state('image.croquettes_dernier_repas'),
            state('image.croquettes_derniere_distribution'),
            state('sensor.croquettes_total_distribue_reservoir_1', '3'),
            state('sensor.salon_temperature', '20'),
        ]);

        expect(rules.map(r => r.metric)).toEqual([
            'light_hours:light.salon',
            'alarm_arms:alarm_control_panel.maison',
            'alarm_triggers:alarm_control_panel.maison',
            'motion:binary_sensor.aarlo_motion_jardin',
            'printer_hours',
            'printer_jobs',
            'spa_heating_hours',
            'spa_temperature',
            'spa_on_hours',
            'plug_hours:switch.prise_pc',
            'washer_cycles',
            'washer_hours',
            'fountain_drinks',
            'feeder_meals',
            'feeder_distributions',
            'feeder_portions:sensor.croquettes_total_distribue_reservoir_1',
        ]);
        const byMetric = Object.fromEntries(rules.map(r => [r.metric, r]));
        expect(byMetric['alarm_arms:alarm_control_panel.maison'].isActive?.('armed_away')).toBe(true);
        expect(byMetric['alarm_triggers:alarm_control_panel.maison'].isActive?.('triggered')).toBe(true);
        expect(byMetric.printer_hours.isActive?.(' Printing ')).toBe(true);
        expect(byMetric.printer_hours.isActive?.('idle')).toBe(false);
        // The heater runs when hvac_action says so; the `heat` mode alone only without it.
        expect(byMetric.spa_heating_hours.isActive?.('heat', { hvac_action: 'idle' })).toBe(false);
        expect(byMetric.spa_heating_hours.isActive?.('heat', { hvac_action: 'heating' })).toBe(true);
        expect(byMetric.spa_heating_hours.isActive?.('heat')).toBe(true);
        expect(byMetric.spa_heating_hours.needsAttributes).toBe(true);
        const spaTemperature = byMetric.spa_temperature;
        expect(spaTemperature.value?.({ state: 'heat', at: 0, attributes: { current_temperature: 37.5 } })).toBe(37.5);
        expect(spaTemperature.value?.({ state: 'heat', at: 0, attributes: { current_temperature: 'n/a' } })).toBeNull();
        expect(spaTemperature.value?.({ state: 'heat', at: 0 })).toBeNull();
    });
});

describe('computeUsage', () => {
    const from = at('2026-11-18T00:00:00Z');
    const to = from + 24 * H;
    const duration: UsageRule = { metric: 'm', entityId: 'light.a', kind: 'duration', isActive: s => s === 'on' };
    const entries: UsageRule = { ...duration, kind: 'entries' };

    it('sums the active hours inside the window, clipping both ends', () => {
        const points = [
            { state: 'on', at: from - 2 * H },
            { state: 'off', at: from + 1 * H },
            { state: 'on', at: from + 10 * H },
            { state: 'unavailable', at: from + 12.5 * H },
            { state: 'on', at: to - 1 * H },
        ];
        expect(computeUsage(duration, points, from, to)).toBe(4.5);
    });

    it('counts the entries into the active state, not the initial one', () => {
        const points = [
            { state: 'on', at: from - H },
            { state: 'off', at: from + H },
            { state: 'on', at: from + 2 * H },
            { state: 'on', at: from + 3 * H },
            { state: 'off', at: from + 4 * H },
            { state: 'on', at: to + H },
        ];
        expect(computeUsage(entries, points, from, to)).toBe(1);
    });

    it('counts the state changes, ignoring a pass through unavailable', () => {
        const rule: UsageRule = { metric: 'm', entityId: 'image.a', kind: 'changes' };
        const points = [
            { state: 't1', at: from - H },
            { state: 'unavailable', at: from + H },
            { state: 't1', at: from + 2 * H },
            { state: 't2', at: from + 3 * H },
            { state: 't3', at: from + 4 * H },
        ];
        expect(computeUsage(rule, points, from, to)).toBe(2);
    });

    it('sums the rises of a counter, resets included', () => {
        const rule: UsageRule = { metric: 'm', entityId: 'sensor.a', kind: 'increase' };
        const points = [
            { state: '10', at: from - H },
            { state: '12', at: from + H },
            { state: 'unknown', at: from + 2 * H },
            { state: '15', at: from + 3 * H },
            { state: '2', at: from + 4 * H },
            { state: 'abc', at: from + 5 * H },
        ];
        expect(computeUsage(rule, points, from, to)).toBe(7);
    });

    it('averages a value over the time it held', () => {
        const rule: UsageRule = {
            metric: 'm',
            entityId: 'climate.spa',
            kind: 'mean',
            value: point => (point.attributes?.t as number | undefined) ?? null,
        };
        const points = [
            { state: 'heat', at: from - H, attributes: { t: 36 } },
            { state: 'heat', at: from + 6 * H, attributes: { t: 38 } },
            { state: 'unavailable', at: from + 18 * H },
        ];
        // 36 °C for 6 h, 38 °C for 12 h, nothing known for the last 6 h.
        expect(computeUsage(rule, points, from, to)).toBe(37.3);
        expect(computeUsage(rule, [{ state: 'x', at: from }], from, to)).toBeNaN();
        expect(computeUsage({ ...rule, value: undefined }, points, from, to)).toBeNaN();
    });

    it('treats a rule without predicate as never active', () => {
        expect(computeUsage({ metric: 'm', entityId: 'x.a', kind: 'duration' }, [{ state: 'on', at: from }], from, to)).toBe(0);
    });
});

describe('days', () => {
    it('bounds a Paris day, DST included', () => {
        expect(parisDayBounds('2026-11-18')).toEqual({ day: '2026-11-18', from: at('2026-11-17T23:00:00Z'), to: at('2026-11-18T23:00:00Z') });
        const autumn = parisDayBounds('2026-10-25');
        expect((autumn.to - autumn.from) / H).toBe(25);
    });

    it('lists the days after the last one done, up to yesterday', () => {
        const now = new Date('2026-11-19T08:00:00Z');
        expect(daysToCompute('2026-11-16', now).map(d => d.day)).toEqual(['2026-11-17', '2026-11-18']);
        expect(daysToCompute('2026-11-18', now)).toEqual([]);
        const first = daysToCompute(null, now);
        expect(first).toHaveLength(MAX_CATCH_UP_DAYS);
        expect(first[first.length - 1].day).toBe('2026-11-18');
    });
});

describe('syncDailyUsage', () => {
    const NOW = new Date('2026-11-19T08:00:00Z');

    beforeEach(() => {
        vi.clearAllMocks();
        resetHAMocks();
        mockPrisma.systemState.findUnique.mockResolvedValue({ key: 'dailyUsage.lastDay', value: '2026-11-17' } as never);
        mockPrisma.notification.findMany.mockResolvedValue([]);
        mockPrisma.$transaction.mockResolvedValue([] as never);
        vi.mocked(getCachedStates).mockResolvedValue({
            ok: true,
            data: [state('switch.prise_pc'), state('switch.prise_tv'), state('binary_sensor.washing_machine_status')],
        });
    });

    it('stores the counters of the missing days and moves the marker', async () => {
        mockHaFetch.mockResolvedValue({
            ok: true,
            status: 200,
            duration: 1,
            data: [
                [
                    { entity_id: 'switch.prise_pc', state: 'on', last_changed: '2026-11-17T23:00:00Z' },
                    { state: 'off', last_changed: '2026-11-18T01:00:00Z' },
                    { state: 'on', last_updated: 'not a date' },
                ],
                [],
                [{ entity_id: 'binary_sensor.washing_machine_status', state: 'off', last_changed: '2026-11-17T23:00:00Z' }, { state: 'on', last_changed: '2026-11-18T10:00:00Z' }, { state: 'off', last_changed: '2026-11-18T11:30:00Z' }],
            ],
        });
        mockPrisma.notification.findMany.mockResolvedValue([
            { category: 'alarm', title: 'Alarme', createdAt: new Date('2026-11-18T09:00:00.100Z') },
            { category: 'alarm', title: 'Alarme', createdAt: new Date('2026-11-18T09:00:00.400Z') },
            { category: 'water', title: 'Fuite', createdAt: new Date('2026-11-18T12:00:00Z') },
        ] as never);
        mockPrisma.dailyUsage.deleteMany.mockImplementation(((args: unknown) => ({ delete: args })) as never);
        mockPrisma.dailyUsage.createMany.mockImplementation(((args: unknown) => ({ create: args })) as never);
        mockPrisma.systemState.upsert.mockImplementation(((args: unknown) => ({ marker: args })) as never);

        const result = await syncDailyUsage(NOW);

        expect(result).toEqual({ days: ['2026-11-18'], rows: 5 });
        const path = mockHaFetch.mock.calls[0][0] as string;
        expect(path).toContain('/api/history/period/2026-11-17T23%3A00%3A00.000Z?');
        expect(path).toContain('end_time=2026-11-18T23%3A00%3A00.000Z');
        expect(path).toContain('minimal_response&no_attributes');
        const [removal, creation, marker] = mockPrisma.$transaction.mock.calls[0][0] as unknown as [
            { delete: { where: { date: Date } } },
            { create: { data: { metric: string; value: number }[] } },
            { marker: { create: unknown } },
        ];
        expect(removal.delete.where.date).toEqual(new Date('2026-11-18T00:00:00Z'));
        expect(Object.fromEntries(creation.create.data.map(r => [r.metric, r.value]))).toEqual({
            'plug_hours:switch.prise_pc': 2,
            washer_cycles: 1,
            washer_hours: 1.5,
            'alerts:alarm': 1,
            'alerts:water': 1,
        });
        expect(marker.marker.create).toEqual({ key: 'dailyUsage.lastDay', value: '2026-11-18' });
    });

    it('catches a backlog up a few days per run, one HA call and one save per day', async () => {
        mockPrisma.systemState.findUnique.mockResolvedValue(null);
        mockHaFetch.mockResolvedValue({ ok: true, status: 200, duration: 1, data: [] });

        const result = await syncDailyUsage(NOW);

        expect(result.days).toEqual(['2026-11-10', '2026-11-11', '2026-11-12']);
        expect(mockHaFetch).toHaveBeenCalledTimes(3);
        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(3);
        expect((await syncDailyUsage(NOW, MAX_CATCH_UP_DAYS)).days).toHaveLength(MAX_CATCH_UP_DAYS);
    });

    it('keeps the days saved before a failing one, and says which day failed', async () => {
        mockPrisma.systemState.findUnique.mockResolvedValue({ key: 'dailyUsage.lastDay', value: '2026-11-15' } as never);
        mockHaFetch
            .mockResolvedValueOnce({ ok: true, status: 200, duration: 1, data: [] })
            .mockResolvedValueOnce({ ok: false, status: 502, duration: 1, data: null });

        await expect(syncDailyUsage(NOW)).rejects.toThrow('HA history unavailable for 2026-11-17 (1 day(s) saved before)');
        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('does nothing when yesterday is done', async () => {
        mockPrisma.systemState.findUnique.mockResolvedValue({ key: 'dailyUsage.lastDay', value: '2026-11-18' } as never);
        expect(await syncDailyUsage(NOW)).toEqual({ days: [], rows: 0 });
        expect(getCachedStates).not.toHaveBeenCalled();
    });

    it('reads the spa with its attributes: real heating hours and mean water temperature', async () => {
        vi.mocked(getCachedStates).mockResolvedValue({ ok: true, data: [state('climate.spa_thermostat', 'heat'), state('switch.prise_pc')] });
        mockHaFetch.mockImplementation((async (path: string) => ({
            ok: true,
            status: 200,
            duration: 1,
            data: path.includes('climate.spa_thermostat')
                ? [[
                    { entity_id: 'climate.spa_thermostat', state: 'heat', last_changed: '2026-11-17T23:00:00Z', attributes: { hvac_action: 'heating', current_temperature: 36 } },
                    { entity_id: 'climate.spa_thermostat', state: 'heat', last_changed: '2026-11-18T05:00:00Z', attributes: { hvac_action: 'idle', current_temperature: 38 } },
                ]]
                : [],
        })) as never);
        mockPrisma.dailyUsage.createMany.mockImplementation(((args: unknown) => ({ create: args })) as never);

        await syncDailyUsage(NOW);

        const paths = mockHaFetch.mock.calls.map(([path]) => path as string);
        expect(paths.find(p => p.includes('climate.spa_thermostat'))).not.toContain('no_attributes');
        expect(paths.find(p => p.includes('switch.prise_pc'))).toContain('no_attributes');
        const creation = (mockPrisma.$transaction.mock.calls[0][0] as unknown as unknown[])[1] as { create: { data: { metric: string; value: number }[] } };
        expect(Object.fromEntries(creation.create.data.map(r => [r.metric, r.value]))).toEqual({
            spa_heating_hours: 6,
            spa_temperature: 37.5,
        });
    });

    it('recomputes the last days on demand, even those already done', async () => {
        mockPrisma.systemState.findUnique.mockResolvedValue({ key: 'dailyUsage.lastDay', value: '2026-11-18' } as never);
        mockHaFetch.mockResolvedValue({ ok: true, status: 200, duration: 1, data: [] });

        const result = await syncDailyUsage(NOW, 2, true);

        expect(result.days).toEqual(['2026-11-17', '2026-11-18']);
        expect(mockPrisma.systemState.findUnique).not.toHaveBeenCalled();
    });

    it('fails without HA states or history, leaving the days to do', async () => {
        vi.mocked(getCachedStates).mockResolvedValueOnce({ ok: false, data: [] });
        await expect(syncDailyUsage(NOW)).rejects.toThrow('HA states unavailable');

        mockHaFetch.mockResolvedValue({ ok: false, status: 502, duration: 1, data: null });
        await expect(syncDailyUsage(NOW)).rejects.toThrow('HA history unavailable');
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('skips the HA history when no entity has a rule', async () => {
        vi.mocked(getCachedStates).mockResolvedValue({ ok: true, data: [] });
        await syncDailyUsage(NOW);
        expect(mockHaFetch).not.toHaveBeenCalled();
        expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it('runs only when due, and never throws', async () => {
        mockPrisma.systemState.findUnique.mockResolvedValue({ key: 'dailyUsage.lastDay', value: '2026-11-18' } as never);
        expect(await syncDailyUsageIfDue(NOW)).toBeNull();

        mockPrisma.systemState.findUnique.mockResolvedValue(null);
        vi.mocked(getCachedStates).mockResolvedValue({ ok: false, data: [] });
        expect(await syncDailyUsageIfDue(NOW)).toBeNull();

        vi.mocked(getCachedStates).mockResolvedValue({ ok: true, data: [] });
        expect((await syncDailyUsageIfDue(NOW))?.days).toHaveLength(3);
    });
});

describe('getDailyUsage', () => {
    it('groups the rows per metric and applies the filter', async () => {
        mockPrisma.dailyUsage.findMany.mockResolvedValue([
            { date: new Date('2026-11-17T00:00:00Z'), metric: 'washer_cycles', value: 1 },
            { date: new Date('2026-11-18T00:00:00Z'), metric: 'washer_cycles', value: 2 },
            { date: new Date('2026-11-18T00:00:00Z'), metric: 'motion:binary_sensor.aarlo_motion_a', value: 4 },
        ] as never);

        const series = await getDailyUsage('2026-11-01', '2026-11-30', metric => !metric.startsWith('motion:'));

        expect(series).toEqual({ washer_cycles: [{ date: '2026-11-17', value: 1 }, { date: '2026-11-18', value: 2 }] });
        expect(mockPrisma.dailyUsage.findMany.mock.calls[0][0]?.where).toEqual({
            date: { gte: new Date('2026-11-01T00:00:00Z'), lte: new Date('2026-11-30T00:00:00Z') },
        });
    });
});
