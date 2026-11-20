/**
 * Unit tests for the Telegram bot command dispatcher (lib/integrations/telegram/commands.ts).
 * All HA / Telegram side-effects are injected, so this file is pure logic.
 */
import { describe, it, expect, vi } from 'vitest';
import { parseCommand, dispatchCommand, commands } from '@/lib/integrations/telegram/commands';
import { escapeHtml } from '@/lib/integrations/telegram';

const makeCtx = (overrides: Partial<Parameters<typeof dispatchCommand>[1]> = {}) => {
    return {
        chatId: 'chat-1',
        callHaService: vi.fn().mockResolvedValue(true),
        getHaState: vi.fn().mockResolvedValue({ state: 'disarmed', attributes: {} }),
        captureCameras: vi.fn().mockResolvedValue([
            { buffer: new ArrayBuffer(8), filename: 'salon.jpg' },
            { buffer: new ArrayBuffer(8), filename: 'entree.jpg' },
        ]),
        sendMessage: vi.fn().mockResolvedValue(true),
        sendPhotos: vi.fn().mockResolvedValue(true),
        ...overrides,
    };
};

describe('parseCommand', () => {
    it('parses simple commands', () => {
        expect(parseCommand('/status')).toEqual({ command: 'status', args: [] });
    });

    it('parses commands with args', () => {
        expect(parseCommand('/arm away now')).toEqual({ command: 'arm', args: ['away', 'now'] });
    });

    it('strips bot username suffix', () => {
        expect(parseCommand('/status@MyHomeBot')).toEqual({ command: 'status', args: [] });
    });

    it('lowercases the command', () => {
        expect(parseCommand('/STATUS')).toEqual({ command: 'status', args: [] });
    });

    it('returns null for non-command text', () => {
        expect(parseCommand('hello')).toBeNull();
        expect(parseCommand('  ')).toBeNull();
    });
});

describe('dispatchCommand', () => {
    it('/status replies with the alarm state label', async () => {
        const ctx = makeCtx({
            getHaState: vi.fn().mockResolvedValue({ state: 'armed_away', attributes: {} }),
        });
        const handled = await dispatchCommand('/status', ctx);
        expect(handled).toBe(true);
        expect(ctx.sendMessage).toHaveBeenCalledWith('chat-1', expect.stringContaining('absent'));
    });

    it('/photo triggers captureCameras and sends photos', async () => {
        const ctx = makeCtx();
        await dispatchCommand('/photo', ctx);

        expect(ctx.captureCameras).toHaveBeenCalledWith([
            'camera.aarlo_salon',
            'camera.aarlo_entree',
        ]);
        expect(ctx.sendPhotos).toHaveBeenCalledTimes(1);
        const [chatId, photos, caption] = (ctx.sendPhotos as any).mock.calls[0];
        expect(chatId).toBe('chat-1');
        expect(photos).toHaveLength(2);
        expect(caption).toContain('Caméras');
    });

    it('/photo replies with error when no photo captured', async () => {
        const ctx = makeCtx({
            captureCameras: vi.fn().mockResolvedValue([]),
        });
        await dispatchCommand('/photo', ctx);
        expect(ctx.sendPhotos).not.toHaveBeenCalled();
        expect(ctx.sendMessage).toHaveBeenLastCalledWith('chat-1', expect.stringContaining('Aucune photo'));
    });

    it('/arm calls alarm_arm_away on the alarm entity', async () => {
        const ctx = makeCtx();
        await dispatchCommand('/arm', ctx);
        expect(ctx.callHaService).toHaveBeenCalledWith(
            'alarm_control_panel',
            'alarm_arm_away',
            'alarm_control_panel.somfy_home_alarm_maison',
        );
        expect(ctx.sendMessage).toHaveBeenCalledWith('chat-1', expect.stringContaining('activée'));
    });

    it('/disarm calls alarm_disarm', async () => {
        const ctx = makeCtx();
        await dispatchCommand('/disarm', ctx);
        expect(ctx.callHaService).toHaveBeenCalledWith(
            'alarm_control_panel',
            'alarm_disarm',
            'alarm_control_panel.somfy_home_alarm_maison',
        );
        expect(ctx.sendMessage).toHaveBeenCalledWith('chat-1', expect.stringContaining('désactivée'));
    });

    it('/arm_night calls alarm_arm_night', async () => {
        const ctx = makeCtx();
        await dispatchCommand('/arm_night', ctx);
        expect(ctx.callHaService).toHaveBeenCalledWith(
            'alarm_control_panel',
            'alarm_arm_night',
            'alarm_control_panel.somfy_home_alarm_maison',
        );
    });

    it('reports failure when HA service call fails', async () => {
        const ctx = makeCtx({ callHaService: vi.fn().mockResolvedValue(false) });
        await dispatchCommand('/arm', ctx);
        expect(ctx.sendMessage).toHaveBeenCalledWith('chat-1', expect.stringContaining('Échec'));
    });

    it('/help lists every registered command', async () => {
        const ctx = makeCtx();
        await dispatchCommand('/help', ctx);
        const [, text] = (ctx.sendMessage as any).mock.calls[0];
        for (const c of Object.values(commands)) {
            expect(text).toContain(c.name);
        }
    });

    it('replies "unknown command" for unregistered commands', async () => {
        const ctx = makeCtx();
        const handled = await dispatchCommand('/banana', ctx);
        expect(handled).toBe(false);
        expect(ctx.sendMessage).toHaveBeenCalledWith('chat-1', expect.stringContaining('inconnue'));
    });

    it('ignores non-command text', async () => {
        const ctx = makeCtx();
        const handled = await dispatchCommand('coucou', ctx);
        expect(handled).toBe(false);
        expect(ctx.sendMessage).not.toHaveBeenCalled();
    });
});

describe('HTML escaping (S15)', () => {
    it('escapes the echoed unknown command', async () => {
        const ctx = makeCtx();
        await dispatchCommand('/<a_href="https://evil.example">x</a>', ctx);

        const sent = vi.mocked(ctx.sendMessage).mock.calls[0][1];
        expect(sent).not.toContain('<a');
        expect(sent).toContain('&lt;a_href=&quot;https://evil.example&quot;&gt;x&lt;/a&gt;');
    });

    it('escapes an unknown alarm state coming from HA', async () => {
        const ctx = makeCtx({ getHaState: vi.fn().mockResolvedValue({ state: '<b>pwn</b>', attributes: {} }) });
        await dispatchCommand('/status', ctx);

        const sent = vi.mocked(ctx.sendMessage).mock.calls.map(([, text]) => text).join('\n');
        expect(sent).toContain('&lt;b&gt;pwn&lt;/b&gt;');
        expect(sent).not.toContain('<b>pwn</b>');
    });

    it('escapeHtml escapes &, <, > and "', () => {
        expect(escapeHtml('a & <b> "c"')).toBe('a &amp; &lt;b&gt; &quot;c&quot;');
    });
});
