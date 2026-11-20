import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { POST } from '@/app/api/telegram/webhook/route';
import { mockPrisma } from '../setup';
import { sendTelegramMessage } from '@/lib/integrations/telegram';
import { mockHaGet, mockHaPost, resetHAMocks } from '../helpers/mock-ha';

vi.mock('@/lib/integrations/arlo', () => ({ captureCameraPhotos: vi.fn().mockResolvedValue([]) }));

vi.mock('@/lib/integrations/telegram', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/integrations/telegram')>()),
    sendTelegramMessage: vi.fn().mockResolvedValue(true),
    sendTelegramMediaGroup: vi.fn().mockResolvedValue(true),
}));

const SECRET = 'telegram_test_secret';

function makeRequest(secret: string | null, body: unknown = { message: { message_id: 1, chat: { id: 42 } } }) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (secret !== null) headers['x-telegram-bot-api-secret-token'] = secret;
    return new Request('http://localhost:3000/api/telegram/webhook', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
}

describe('POST /api/telegram/webhook — secret check (S14)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    });

    afterEach(() => {
        delete process.env.TELEGRAM_WEBHOOK_SECRET;
    });

    it('refuses every call when the secret is not configured', async () => {
        delete process.env.TELEGRAM_WEBHOOK_SECRET;
        const res = await POST(makeRequest(SECRET));
        expect(res.status).toBe(500);
    });

    it.each([null, '', 'wrong', `${SECRET}x`, SECRET.slice(0, -1)])('returns 401 for secret %j', async (secret) => {
        const res = await POST(makeRequest(secret));

        expect(res.status).toBe(401);
        expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
    });

    it('acknowledges a non-text update when the secret matches', async () => {
        const res = await POST(makeRequest(SECRET));

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
    });
});

describe('POST /api/telegram/webhook — commands', () => {
    const textUpdate = (text: string, chatId = 42) => ({ message: { message_id: 1, chat: { id: chatId }, text } });

    beforeEach(() => {
        vi.clearAllMocks();
        resetHAMocks();
        process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    });

    afterEach(() => {
        delete process.env.TELEGRAM_WEBHOOK_SECRET;
    });

    it('returns 400 on a malformed body', async () => {
        const req = new Request('http://localhost:3000/api/telegram/webhook', {
            method: 'POST',
            headers: { 'x-telegram-bot-api-secret-token': SECRET },
            body: '{not json',
        });

        expect((await POST(req)).status).toBe(400);
    });

    it('only accepts chats linked to an admin account', async () => {
        mockPrisma.user.findFirst.mockResolvedValue(null);

        const res = await POST(makeRequest(SECRET, textUpdate('/disarm', 666)));

        expect(res.status).toBe(200);
        expect(mockPrisma.user.findFirst).toHaveBeenCalledWith({ where: { telegramChatId: '666', group: 'admin' }, select: { id: true } });
        expect(sendTelegramMessage).toHaveBeenCalledWith('666', '❌ Accès refusé');
        expect(mockHaPost).not.toHaveBeenCalled();
    });

    it('runs a command for an admin chat through Home Assistant', async () => {
        mockPrisma.user.findFirst.mockResolvedValue({ id: 1 } as never);
        mockHaPost.mockResolvedValue({ ok: true, status: 200, duration: 1, data: {} });

        await POST(makeRequest(SECRET, textUpdate('/disarm')));

        expect(mockHaPost).toHaveBeenCalledWith(
            '/api/services/alarm_control_panel/alarm_disarm',
            { entity_id: 'alarm_control_panel.somfy_home_alarm_maison' },
            'tg-cmd:alarm_control_panel.alarm_disarm',
        );
        expect(sendTelegramMessage).toHaveBeenCalledWith('42', expect.stringContaining('Alarme'));
    });

    it('reads states through Home Assistant for /status', async () => {
        mockPrisma.user.findFirst.mockResolvedValue({ id: 1 } as never);
        // HA may omit attributes: the command must cope with it
        mockHaGet.mockResolvedValue({ ok: true, status: 200, duration: 1, data: { state: 'armed_away' } });

        await POST(makeRequest(SECRET, textUpdate('/status')));

        expect(mockHaGet).toHaveBeenCalledWith(
            '/api/states/alarm_control_panel.somfy_home_alarm_maison',
            'tg-cmd:state:alarm_control_panel.somfy_home_alarm_maison',
        );
        expect(sendTelegramMessage).toHaveBeenCalledWith('42', expect.stringContaining('activée (absent)'));
    });

    it('reports an unreadable alarm state when HA answers with an error', async () => {
        mockPrisma.user.findFirst.mockResolvedValue({ id: 1 } as never);
        mockHaGet.mockResolvedValue({ ok: false, status: 502, duration: 1, data: null });

        await POST(makeRequest(SECRET, textUpdate('/status')));

        expect(sendTelegramMessage).toHaveBeenCalledWith('42', expect.stringContaining('Impossible de lire'));
    });

    it('answers with a generic error when a command throws', async () => {
        mockPrisma.user.findFirst.mockResolvedValue({ id: 1 } as never);
        mockHaGet.mockRejectedValue(new Error('HA unreachable at 10.0.0.2'));

        const res = await POST(makeRequest(SECRET, textUpdate('/status')));

        expect(res.status).toBe(200);
        expect(sendTelegramMessage).toHaveBeenLastCalledWith('42', '❌ Erreur interne');
    });
});
