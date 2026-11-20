import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendTelegramMessage, sendTelegramMediaGroup } from '@/lib/integrations/telegram';

const photo = (name: string) => ({ buffer: new ArrayBuffer(4), filename: name });

describe('Telegram client', () => {
    beforeEach(() => {
        vi.stubEnv('TELEGRAM_BOT_TOKEN', 'bot-token');
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    describe('sendTelegramMessage', () => {
        it('posts an HTML message without link previews', async () => {
            const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}'));

            expect(await sendTelegramMessage('42', '<b>hi</b>')).toBe(true);

            expect(fetchSpy.mock.calls[0][0]).toBe('https://api.telegram.org/botbot-token/sendMessage');
            expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toEqual({
                chat_id: '42',
                text: '<b>hi</b>',
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            });
        });

        it('returns false without a bot token, on HTTP errors and on network errors', async () => {
            const fetchSpy = vi.spyOn(global, 'fetch');

            vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
            expect(await sendTelegramMessage('42', 'x')).toBe(false);
            expect(fetchSpy).not.toHaveBeenCalled();

            vi.stubEnv('TELEGRAM_BOT_TOKEN', 'bot-token');
            fetchSpy.mockResolvedValueOnce(new Response('Bad Request: can\'t parse entities', { status: 400 }));
            expect(await sendTelegramMessage('42', 'x')).toBe(false);

            fetchSpy.mockRejectedValueOnce(new Error('offline'));
            expect(await sendTelegramMessage('42', 'x')).toBe(false);
        });
    });

    describe('sendTelegramMediaGroup', () => {
        it('uses sendPhoto with the caption for a single photo', async () => {
            const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}'));

            expect(await sendTelegramMediaGroup('42', [photo('a.jpg')], 'Alarme')).toBe(true);

            expect(fetchSpy.mock.calls[0][0]).toBe('https://api.telegram.org/botbot-token/sendPhoto');
            const form = fetchSpy.mock.calls[0][1]?.body as FormData;
            expect(form.get('caption')).toBe('Alarme');
            expect(form.get('parse_mode')).toBe('HTML');
        });

        it('sends an album of at most 10 photos with the caption on the first one', async () => {
            const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}'));
            const photos = Array.from({ length: 12 }, (_, i) => photo(`p${i}.jpg`));

            expect(await sendTelegramMediaGroup('42', photos, 'Mouvement')).toBe(true);

            expect(fetchSpy.mock.calls[0][0]).toBe('https://api.telegram.org/botbot-token/sendMediaGroup');
            const form = fetchSpy.mock.calls[0][1]?.body as FormData;
            const media = JSON.parse(String(form.get('media')));
            expect(media).toHaveLength(10);
            expect(media[0]).toMatchObject({ media: 'attach://photo0', caption: 'Mouvement', parse_mode: 'HTML' });
            expect(media[1].caption).toBeUndefined();
            expect(form.get('photo10')).toBeNull();
        });

        it('returns false without photos, without token, on HTTP errors and on network errors', async () => {
            const fetchSpy = vi.spyOn(global, 'fetch');

            expect(await sendTelegramMediaGroup('42', [], 'x')).toBe(false);

            vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
            expect(await sendTelegramMediaGroup('42', [photo('a')], 'x')).toBe(false);
            expect(fetchSpy).not.toHaveBeenCalled();

            vi.stubEnv('TELEGRAM_BOT_TOKEN', 'bot-token');
            fetchSpy.mockResolvedValueOnce(new Response('err', { status: 500 }));
            expect(await sendTelegramMediaGroup('42', [photo('a')], 'x')).toBe(false);

            fetchSpy.mockResolvedValueOnce(new Response('err', { status: 500 }));
            expect(await sendTelegramMediaGroup('42', [photo('a'), photo('b')], 'x')).toBe(false);

            fetchSpy.mockRejectedValueOnce(new Error('offline'));
            expect(await sendTelegramMediaGroup('42', [photo('a'), photo('b')], 'x')).toBe(false);
        });
    });
});
