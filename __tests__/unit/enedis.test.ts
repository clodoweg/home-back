import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockPrisma } from '../setup';
import { getEnedisData, syncEnedisData } from '@/lib/integrations/enedis';
import { apiFetch, fetchDailyConsumption, formatDate } from '@/lib/integrations/enedis/client';

const NOW = new Date(Date.UTC(2026, 9, 22, 14, 30));

function enedisPayload(readings: Array<{ date: string; value: string }>) {
    return new Response(JSON.stringify({ meter_reading: { interval_reading: readings } }), { status: 200 });
}

describe('Enedis client', () => {
    beforeEach(() => {
        vi.stubEnv('ENEDIS_PDL', '12345678901234');
        vi.stubEnv('ENEDIS_TOKEN', 'enedis-token');
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('formats dates as UTC days', () => {
        expect(formatDate(new Date(Date.UTC(2026, 0, 5, 23, 59)))).toBe('2026-01-05');
    });

    it('calls MyElectricalData with the PDL, the date range and the token', async () => {
        const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{"ok":true}'));

        await expect(fetchDailyConsumption(new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2026, 0, 31)))).resolves.toEqual({ ok: true });

        expect(fetchSpy).toHaveBeenCalledWith(
            'https://www.myelectricaldata.fr/daily_consumption/12345678901234/start/2026-01-01/end/2026-01-31',
            { headers: { Authorization: 'enedis-token', 'Content-Type': 'application/json' } },
        );
    });

    it('throws on HTTP errors and without PDL', async () => {
        vi.spyOn(global, 'fetch').mockResolvedValue(new Response('quota', { status: 429, statusText: 'Too Many Requests' }));
        await expect(apiFetch('x')).rejects.toThrow('[Enedis] API Error 429');

        vi.stubEnv('ENEDIS_PDL', '');
        await expect(fetchDailyConsumption(NOW, NOW)).rejects.toThrow('Missing ENEDIS_PDL');
    });
});

describe('syncEnedisData', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers({ now: NOW });
        vi.stubEnv('ENEDIS_PDL', '12345678901234');
        mockPrisma.$transaction.mockResolvedValue([] as never);
        mockPrisma.enedisDailyConsumption.upsert.mockReturnValue('upsert-daily' as never);
        mockPrisma.enedisDailyMaxPower.upsert.mockReturnValue('upsert-max' as never);
        mockPrisma.enedisLoadCurve.upsert.mockReturnValue('upsert-curve' as never);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('upserts every reading, rounded, in one transaction per series', async () => {
        vi.spyOn(global, 'fetch').mockImplementation(async () =>
            enedisPayload([{ date: '2026-10-21', value: '1234.6' }, { date: '2026-10-22', value: '99.4' }]),
        );

        const result = await syncEnedisData(1);

        expect(result).toEqual({ success: true });
        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(3);
        expect(mockPrisma.enedisDailyConsumption.upsert).toHaveBeenCalledWith({
            where: { date: new Date('2026-10-21') },
            update: { value: 1235 },
            create: { date: new Date('2026-10-21'), value: 1235 },
        });
        expect(mockPrisma.enedisDailyConsumption.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { value: 99 } }));
    });

    it('limits the load curve to the last 2 days and can skip it', async () => {
        const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => enedisPayload([]));

        await syncEnedisData(30, false);

        const urls = fetchSpy.mock.calls.map(([url]) => String(url));
        expect(urls.some(url => url.includes('consumption_load_curve'))).toBe(false);
        expect(mockPrisma.$transaction).not.toHaveBeenCalled();

        fetchSpy.mockClear();
        await syncEnedisData(30);
        const curveUrls = fetchSpy.mock.calls.map(([url]) => String(url)).filter(url => url.includes('consumption_load_curve'));
        expect(curveUrls).toEqual([
            'https://www.myelectricaldata.fr/consumption_load_curve/12345678901234/start/2026-10-20/end/2026-10-22',
        ]);
    });

    it('splits long ranges in 30-day chunks, throttled by 1 s', async () => {
        const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => enedisPayload([]));

        const pending = syncEnedisData(45, false);
        await vi.runAllTimersAsync();
        await pending;

        const dailyUrls = fetchSpy.mock.calls.map(([url]) => String(url)).filter(url => url.includes('/daily_consumption/'));
        expect(dailyUrls).toEqual([
            'https://www.myelectricaldata.fr/daily_consumption/12345678901234/start/2026-09-07/end/2026-10-07',
            'https://www.myelectricaldata.fr/daily_consumption/12345678901234/start/2026-10-07/end/2026-10-22',
        ]);
    });

    it('reports a failure when one chunk fails, without stopping the others', async () => {
        vi.spyOn(global, 'fetch').mockImplementation(async (url) =>
            String(url).includes('max_power') ? new Response('down', { status: 500 }) : enedisPayload([{ date: '2026-10-21', value: '1' }]),
        );

        expect(await syncEnedisData(1)).toEqual({ success: false });
        expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
    });
});

describe('getEnedisData', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers({ now: NOW });
        mockPrisma.enedisDailyConsumption.findMany.mockResolvedValue([{ date: NOW, value: 1 }] as never);
        mockPrisma.enedisDailyMaxPower.findMany.mockResolvedValue([] as never);
        mockPrisma.enedisLoadCurve.findMany.mockResolvedValue([] as never);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('defaults to Jan 1st of the previous year and a 15-day load curve (characterization, UTC server)', async () => {
        const data = await getEnedisData();

        expect(data.dailyConsumption).toHaveLength(1);
        expect(mockPrisma.enedisDailyConsumption.findMany).toHaveBeenCalledWith({
            where: { date: { gte: new Date(Date.UTC(2025, 0, 1)), lte: NOW } },
            orderBy: { date: 'asc' },
        });
        expect(mockPrisma.enedisLoadCurve.findMany).toHaveBeenCalledWith({
            where: { date: { gte: new Date(Date.UTC(2026, 9, 7)), lte: NOW } },
            orderBy: { date: 'asc' },
        });
    });

    it('uses the explicit ranges when provided', async () => {
        const start = new Date(Date.UTC(2026, 0, 1));
        const end = new Date(Date.UTC(2026, 1, 1));
        const curveStart = new Date(Date.UTC(2026, 0, 25));

        await getEnedisData(start, end, curveStart);

        expect(mockPrisma.enedisDailyMaxPower.findMany).toHaveBeenCalledWith({
            where: { date: { gte: start, lte: end } },
            orderBy: { date: 'asc' },
        });
        expect(mockPrisma.enedisLoadCurve.findMany).toHaveBeenCalledWith({
            where: { date: { gte: curveStart, lte: end } },
            orderBy: { date: 'asc' },
        });
    });

    it('caps client ranges: 3 years of daily data, 31 days of load curve (P11)', async () => {
        await getEnedisData(new Date(Date.UTC(2000, 0, 1)), NOW, new Date(Date.UTC(2020, 0, 1)));

        const dailyStart = (mockPrisma.enedisDailyConsumption.findMany.mock.calls[0][0] as { where: { date: { gte: Date } } }).where.date.gte;
        const curveStart = (mockPrisma.enedisLoadCurve.findMany.mock.calls[0][0] as { where: { date: { gte: Date } } }).where.date.gte;
        expect(dailyStart).toEqual(new Date(NOW.getTime() - 3 * 366 * 24 * 3600 * 1000));
        expect(curveStart).toEqual(new Date(NOW.getTime() - 31 * 24 * 3600 * 1000));
    });
});

