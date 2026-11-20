/**
 * Characterization tests for PetkitApiService.getFormattedPetkitData.
 * They freeze the output (snapshots): a refactor must keep these snapshots unchanged.
 * The split of lot 4 kept them identical; they were then updated on purpose for F16
 * (future meals) and F09 (Paris days and hours), findings of the October 2026 audit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as PetkitApiService from '@/lib/integrations/petkit';
import type { FeederDevice, FountainDevice } from '@/lib/integrations/petkit';

const feederOf = (result: PetkitApiService.PetkitData) => result.devices[0] as FeederDevice;
import { mockHaFetch, mockHaGet, mockHaPost, resetHAMocks } from '../helpers/mock-ha';
import { resetStatesCache } from '@/lib/ha-states-cache';

// 2026-10-22 16:00 in Paris (UTC+2)
const NOW = new Date(Date.UTC(2026, 9, 22, 14, 0, 0));
const TODAY = '2026-10-22';
const YESTERDAY = '2026-10-21';

type Entry = { entity_id: string; state: string; last_changed: string; attributes?: Record<string, unknown> };

const state = (entity_id: string, value: string): Entry => ({ entity_id, state: value, last_changed: `${TODAY}T10:00:00Z`, attributes: {} });
const at = (entity_id: string, value: string, lastChanged: string): Entry => ({ entity_id, state: value, last_changed: lastChanged });

// Meals: id,hour,minute,amount,bacSelector — 07:00 bac1, 12:30 bac2, 19:00 split
const RAW_SCHEDULE = '1,7,0,10,0,2,12,30,8,1,3,19,0,12,6';

function feederStates(overrides: Record<string, string> = {}): Entry[] {
    const values: Record<string, string> = {
        'binary_sensor.croquettes_niveau_nourriture_reservoir_1': 'off',
        'binary_sensor.croquettes_niveau_nourriture_reservoir_2': 'on',
        'sensor.croquettes_niveau_de_batterie': '87',
        'binary_sensor.croquettes_sur_batterie': 'off',
        'sensor.croquettes_niveau_de_l_absorbeur_d_humidite': '64',
        'sensor.croquettes_total_programme_reservoir_1': '20',
        'sensor.croquettes_total_programme_reservoir_2': '10',
        'sensor.croquettes_donnees_brutes_de_distribution': RAW_SCHEDULE,
        'sensor.croquettes_nombre_de_repas': '5',
        'sensor.croquettes_temps_moyen_de_repas': '42',
        'image.croquettes_dernier_repas': `${TODAY} 13:05:10`,
        'image.croquettes_derniere_distribution': `${TODAY} 12:30:05`,
        'image.croquettes_derniere_visite': `${TODAY} 15:40:00`,
        ...overrides,
    };
    return Object.entries(values).map(([id, value]) => state(id, value));
}

function fountainStates(overrides: Record<string, string> = {}): Entry[] {
    const values: Record<string, string> = {
        'switch.eau_alimentation': 'on',
        'binary_sensor.eau_pump': 'on',
        'binary_sensor.eau_sur_alimentation_secteur': 'on',
        'sensor.eau_battery': '76',
        'sensor.eau_filtre_restant': '58',
        'binary_sensor.eau_alerte_manque_d_eau': 'off',
        'binary_sensor.eau_pet_drinking': 'off',
        ...overrides,
    };
    return Object.entries(values).map(([id, value]) => state(id, value));
}

/** History as HA returns it: one sub-array per entity, entities without data omitted. */
const FULL_HISTORY: Entry[][] = [
    [
        at('image.croquettes_dernier_repas', `${TODAY} 07:05:00`, `${TODAY}T05:05:00Z`),
        at('image.croquettes_dernier_repas', 'unavailable', `${TODAY}T06:00:00Z`),
        at('image.croquettes_dernier_repas', `${TODAY} 13:05:10`, `${TODAY}T11:05:10Z`),
    ],
    [
        at('image.croquettes_derniere_distribution', `${TODAY} 07:00:20`, `${TODAY}T05:00:20Z`),
        at('image.croquettes_derniere_distribution', `${TODAY} 12:30:05`, `${TODAY}T10:30:05Z`),
    ],
    [at('image.croquettes_derniere_visite', `${YESTERDAY} 23:50:00`, `${YESTERDAY}T21:50:00Z`)],
    [at('image.croquettes_dernier_mouvement', `${TODAY} 09:15:00`, `${TODAY}T07:15:00Z`)],
    [
        at('image.croquettes_dish_before', `${TODAY} 06:59:00`, `${TODAY}T04:59:00Z`),
        at('image.croquettes_dish_before', `${TODAY} 13:00:00`, `${TODAY}T11:00:00Z`),
    ],
    [
        at('image.croquettes_dish_after', `${TODAY} 07:08:00`, `${TODAY}T05:08:00Z`),
        at('image.croquettes_dish_after', `${TODAY} 18:00:00`, `${TODAY}T16:00:00Z`),
    ],
    [
        at('sensor.croquettes_total_distribue_reservoir_1', '0', `${TODAY}T00:00:00Z`),
        at('sensor.croquettes_total_distribue_reservoir_1', 'unknown', `${TODAY}T01:00:00Z`),
        at('sensor.croquettes_total_distribue_reservoir_1', '10', `${TODAY}T05:00:30Z`),
        at('sensor.croquettes_total_distribue_reservoir_1', '16', `${TODAY}T08:00:00Z`),
    ],
    [
        at('sensor.croquettes_total_distribue_reservoir_2', '0', `${TODAY}T00:00:00Z`),
        at('sensor.croquettes_total_distribue_reservoir_2', '8', `${TODAY}T10:30:10Z`),
    ],
    [
        at('sensor.croquettes_donnees_brutes_de_distribution', RAW_SCHEDULE, `${TODAY}T04:00:00Z`),
        at('sensor.croquettes_donnees_brutes_de_distribution', RAW_SCHEDULE, `${TODAY}T09:00:00Z`),
        at('sensor.croquettes_donnees_brutes_de_distribution', 'unknown', `${TODAY}T09:30:00Z`),
        at('sensor.croquettes_donnees_brutes_de_distribution', '9,5,0,0,0,4,abc,1,x,0', `${TODAY}T09:40:00Z`),
    ],
    [
        at('binary_sensor.eau_pet_drinking', 'on', `${TODAY}T05:00:00Z`),
        at('binary_sensor.eau_pet_drinking', 'off', `${TODAY}T05:01:30Z`),
        at('binary_sensor.eau_pet_drinking', 'on', `${TODAY}T11:00:00Z`),
        at('binary_sensor.eau_pet_drinking', 'off', `${TODAY}T11:20:00Z`),
        at('binary_sensor.eau_pet_drinking', 'off', `${TODAY}T11:30:00Z`),
        at('binary_sensor.eau_pet_drinking', 'on', `${YESTERDAY}T20:00:00Z`),
        at('binary_sensor.eau_pet_drinking', 'off', `${YESTERDAY}T20:00:40Z`),
    ],
    [
        at('sensor.eau_nombre_de_boissons', '3', `${TODAY}T00:00:00Z`),
        at('sensor.eau_nombre_de_boissons', '4', `${TODAY}T05:00:30Z`),
        at('sensor.eau_nombre_de_boissons', 'n/a', `${TODAY}T06:00:00Z`),
        at('sensor.eau_nombre_de_boissons', '5', `${TODAY}T13:00:00Z`),
    ],
];

function mockHa(states: Entry[] | null, history: Entry[][] | null = FULL_HISTORY) {
    resetStatesCache();
    // States go through the shared states cache (haFetch), history through haGet
    mockHaFetch.mockResolvedValue({ ok: states !== null, status: states ? 200 : 502, duration: 1, data: states } as never);
    mockHaGet.mockResolvedValue({ ok: history !== null, status: history ? 200 : 502, duration: 1, data: history } as never);
}

describe('PetkitApiService.getFormattedPetkitData — characterization', () => {
    beforeEach(() => {
        vi.useFakeTimers({ now: NOW });
        resetHAMocks();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('returns empty collections when HA states cannot be read', async () => {
        mockHa(null);

        expect(await PetkitApiService.getFormattedPetkitData(2, true)).toEqual({
            devices: [],
            records: [],
            fountains: [],
            lastSyncedAt: NOW.toISOString(),
            historyHealth: { ok: true, status: 200 },
        });
    });

    it('requests the whole history in one batched call with a 5-minute buffer', async () => {
        mockHa([...feederStates(), ...fountainStates()]);

        await PetkitApiService.getFormattedPetkitData(2, true);

        expect(mockHaGet).toHaveBeenCalledWith(
            '/api/history/period/2026-10-20T14:00:00Z?filter_entity_id=image.croquettes_dernier_repas,image.croquettes_derniere_distribution,image.croquettes_derniere_visite,image.croquettes_dernier_mouvement,image.croquettes_dish_before,image.croquettes_dish_after,sensor.croquettes_total_distribue_reservoir_1,sensor.croquettes_total_distribue_reservoir_2,sensor.croquettes_donnees_brutes_de_distribution,binary_sensor.eau_pet_drinking,sensor.eau_nombre_de_boissons&end_time=2026-10-22T14:05:00Z&no_attributes',
            'petkit-history-batch',
        );
    });

    it('synthesizes feeder records and fountain activity from the full history (history access)', async () => {
        mockHa([...feederStates(), ...fountainStates()]);

        const result = await PetkitApiService.getFormattedPetkitData(2, true);

        // 10 portions at 07:00 + 6 from a counter increment; the 19:00 meal is still to come (F16)
        expect(feederOf(result).dailyFeed).toMatchObject({ realAmountTotal1: 16, realAmountTotal2: 8, planAmountTotal1: 20, planAmountTotal2: 10 });
        expect(feederOf(result).status).toMatchObject({ food1: 2, food2: 1, batteryPower: 87, batteryStatus: 1, pim: 64 });
        expect(result.fountains.map(f => f.day)).toEqual([TODAY, YESTERDAY]);
        expect(result).toMatchSnapshot();
    });

    it('builds records from current images only, without previews, without history access', async () => {
        mockHa([...feederStates(), ...fountainStates()]);

        const result = await PetkitApiService.getFormattedPetkitData(1, false);

        expect(mockHaGet).not.toHaveBeenCalled();
        expect(JSON.stringify(result.records)).not.toContain('/api/ha/');
        expect(result).toMatchSnapshot();
    });

    it('scales the scheduled meals to the "total distribué" counters when history yields nothing', async () => {
        mockHa(
            [
                ...feederStates({
                    'sensor.croquettes_total_distribue_reservoir_1': '15',
                    'sensor.croquettes_total_distribue_reservoir_2': '9.6',
                    'image.croquettes_derniere_distribution': 'unknown',
                }),
            ],
            [],
        );

        const result = await PetkitApiService.getFormattedPetkitData(1, true);

        expect(feederOf(result).dailyFeed).toMatchObject({ realAmountTotal1: 15, realAmountTotal2: 10 });
        const distributions = result.records.filter(r => r.type === 4);
        expect(distributions.reduce((sum, r) => sum + (r.amount1 ?? 0), 0)).toBe(15);
        expect(distributions.reduce((sum, r) => sum + (r.amount2 ?? 0), 0)).toBe(10);
        expect(result).toMatchSnapshot();
    });

    it('falls back on the planned amounts without counters', async () => {
        mockHa(feederStates({ 'image.croquettes_derniere_distribution': 'unavailable' }), null);

        const result = await PetkitApiService.getFormattedPetkitData(1, true);

        expect(feederOf(result).dailyFeed).toMatchObject({ realAmountTotal1: 10, realAmountTotal2: 8 });
        // Only the 07:00 and 12:30 meals have happened at 16:00 (F16)
        expect(result.records.filter(r => r.type === 4)).toHaveLength(2);
        expect(result).toMatchSnapshot();
    });

    it('emits a single aggregate record from the counters when there is no schedule', async () => {
        mockHa(
            feederStates({
                'sensor.croquettes_donnees_brutes_de_distribution': '',
                'sensor.croquettes_total_programme_reservoir_1': '0',
                'sensor.croquettes_total_programme_reservoir_2': '0',
                'sensor.croquettes_total_distribue_reservoir_1': '12',
                'sensor.croquettes_niveau_de_batterie': 'unknown',
                'image.croquettes_derniere_distribution': 'unknown',
            }),
            [],
        );

        const result = await PetkitApiService.getFormattedPetkitData(1, true);

        expect(feederOf(result).status.batteryPower).toBe(100);
        expect(result.records).toContainEqual(
            expect.objectContaining({ type: 4, content: 'Distribution (total jour)', amount1: 12, amount2: 0, time: NOW.getTime() / 1000 }),
        );
        expect(result).toMatchSnapshot();
    });

    it('reports an ongoing drink and the legacy fontaine_* entities', async () => {
        mockHa(
            [
                state('binary_sensor.eau_pet_drinking', 'on'),
                state('switch.fontaine_alimentation', 'on'),
                state('switch.fontaine_pompe', 'on'),
                state('binary_sensor.fontaine_secteur', 'on'),
                state('sensor.fontaine_batterie', '33'),
                state('sensor.fontaine_etat_du_filtre', '12'),
                state('binary_sensor.fontaine_manque_d_eau', 'on'),
            ],
            [[at('binary_sensor.eau_pet_drinking', 'on', `${TODAY}T13:58:00Z`)]],
        );

        const result = await PetkitApiService.getFormattedPetkitData(1, true);

        expect(result.devices).toHaveLength(1);
        expect((result.devices[0] as FountainDevice).status).toEqual({ powerStatus: 1, runStatus: 1, electricStatus: 2, battery: 33, pim: 12, waterLevel: 1 });
        // 13:58 UTC is 15:58 in Paris (F09)
        expect(result.fountains[0].workRecords).toEqual([{ time: Date.UTC(2026, 9, 22, 13, 58) / 1000, dayTime: 15 * 3600 + 58 * 60, stayTime: 120 }]);
        expect(result.fountains[0].data.activity).toEqual({ morning: 0, afternoon: 1, night: 0 });
        expect(result).toMatchSnapshot();
    });
});

describe('PetkitApiService.triggerFeederManual', () => {
    beforeEach(() => {
        resetHAMocks();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('sets both amounts then presses the manual distribution button', async () => {
        mockHaPost.mockResolvedValue({ ok: true, status: 200, duration: 1, data: {} });

        expect(await PetkitApiService.triggerFeederManual(1, 2, 3)).toBe(true);

        expect(mockHaPost.mock.calls.map(([path, body]) => [path, body])).toEqual([
            ['/api/services/text/set_value', { entity_id: 'text.croquettes_distribution_manuelle_reservoir_1', value: '2' }],
            ['/api/services/text/set_value', { entity_id: 'text.croquettes_distribution_manuelle_reservoir_2', value: '3' }],
            ['/api/services/button/press', { entity_id: 'button.croquettes_distribution_manuelle' }],
        ]);
    });

    it('still presses the button when setting an amount fails, and reports the button result', async () => {
        mockHaPost
            .mockResolvedValueOnce({ ok: false, status: 500, duration: 1, data: null })
            .mockResolvedValueOnce({ ok: true, status: 200, duration: 1, data: {} })
            .mockResolvedValueOnce({ ok: false, status: 500, duration: 1, data: null });

        expect(await PetkitApiService.triggerFeederManual(1, 2, 3)).toBe(false);
        expect(mockHaPost).toHaveBeenCalledTimes(3);
    });

    it('returns false when HA throws', async () => {
        mockHaPost.mockRejectedValue(new Error('timeout'));

        expect(await PetkitApiService.triggerFeederManual(1, 2, 3)).toBe(false);
    });
});

describe('Petkit fountain days around clock changes (F09)', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it.each([
        ['spring forward', Date.UTC(2026, 2, 29, 22, 30), ['2026-03-30', '2026-03-29', '2026-03-28']],
        ['fall back', Date.UTC(2026, 9, 25, 22, 30), ['2026-10-25', '2026-10-24', '2026-10-23']],
    ])('lists each Paris day exactly once (%s)', async (_label, now, expectedDays) => {
        vi.useFakeTimers({ now: new Date(now) });
        mockHa([state('binary_sensor.eau_pet_drinking', 'off')], []);

        const result = await PetkitApiService.getFormattedPetkitData(3, true);

        expect(result.fountains.map(f => f.day)).toEqual(expectedDays);
    });
});

