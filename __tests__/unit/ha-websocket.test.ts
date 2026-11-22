import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { haWebSocketCommand, haWebSocketUrl, HAWebSocketError, HA_WS_TIMEOUT_MS } from '@/lib/ha-websocket';

type Listener = (event: { data?: unknown }) => void;

/** Fake WebSocket driven by the test: `serverSends` plays HA's side of the exchange. */
class FakeSocket {
    static last: FakeSocket;
    url: string;
    sent: Record<string, unknown>[] = [];
    closed = false;
    listeners: Record<string, Listener[]> = {};
    constructor(url: string) {
        this.url = url;
        FakeSocket.last = this;
    }
    addEventListener(type: string, listener: Listener) {
        this.listeners[type] ??= [];
        this.listeners[type].push(listener);
    }
    send(data: string) {
        this.sent.push(JSON.parse(data));
    }
    close() {
        this.closed = true;
    }
    emit(type: string, event: { data?: unknown } = {}) {
        for (const listener of this.listeners[type] ?? []) listener(event);
    }
    serverSends(message: unknown) {
        this.emit('message', { data: typeof message === 'string' ? message : JSON.stringify(message) });
    }
}

const COMMAND = { type: 'recorder/statistics_during_period', statistic_ids: ['sensor.t'] };

describe('haWebSocketCommand', () => {
    beforeEach(() => {
        vi.stubGlobal('WebSocket', FakeSocket);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('derives the WebSocket URL from HA_BASE_URL', () => {
        expect(haWebSocketUrl()).toBe('ws://ha-mock.local:8123/api/websocket');
        vi.stubEnv('HA_BASE_URL', 'https://ha.example.org');
        expect(haWebSocketUrl()).toBe('wss://ha.example.org/api/websocket');
        vi.unstubAllEnvs();
    });

    it('authenticates, sends the command and resolves with its result', async () => {
        const pending = haWebSocketCommand(COMMAND, 'test');
        const socket = FakeSocket.last;

        socket.serverSends({ type: 'auth_required' });
        expect(socket.sent[0]).toEqual({ type: 'auth', access_token: 'test-ha-token' });
        socket.serverSends({ type: 'auth_ok' });
        expect(socket.sent[1]).toEqual({ ...COMMAND, id: 1 });
        socket.serverSends({ type: 'event', id: 9 });
        socket.serverSends({ type: 'result', id: 1, success: true, result: { 'sensor.t': [] } });

        await expect(pending).resolves.toEqual({ 'sensor.t': [] });
        expect(socket.closed).toBe(true);
    });

    it.each([
        ['a refused token', { type: 'auth_invalid' }, 'auth refused'],
        ['a refused command', { type: 'result', id: 1, success: false, error: { message: 'Unknown statistic' } }, 'Unknown statistic'],
        ['a refused command without message', { type: 'result', id: 1, success: false, error: { code: 'invalid_format' } }, 'invalid_format'],
        ['a refused command without detail', { type: 'result', id: 1, success: false }, 'command refused'],
        ['an invalid message', 'not json', 'invalid message'],
    ])('rejects on %s', async (_name, message, error) => {
        const pending = haWebSocketCommand(COMMAND, 'test');
        FakeSocket.last.serverSends(message);
        await expect(pending).rejects.toThrow(new HAWebSocketError(error));
    });

    it('rejects when the connection fails or closes before the answer', async () => {
        const failing = haWebSocketCommand(COMMAND, 'test');
        FakeSocket.last.emit('error');
        await expect(failing).rejects.toThrow('connection error');

        const closing = haWebSocketCommand(COMMAND, 'test');
        FakeSocket.last.emit('close');
        await expect(closing).rejects.toThrow('connection closed');
    });

    it('rejects after the timeout and ignores what comes later', async () => {
        vi.useFakeTimers();
        const pending = haWebSocketCommand(COMMAND, 'test');
        const assertion = expect(pending).rejects.toThrow('timeout');
        vi.advanceTimersByTime(HA_WS_TIMEOUT_MS);
        await assertion;
        FakeSocket.last.serverSends({ type: 'result', id: 1, success: true, result: {} });
    });

    it('survives a socket that throws on close', async () => {
        const pending = haWebSocketCommand(COMMAND, 'test');
        FakeSocket.last.close = () => {
            throw new Error('already closed');
        };
        FakeSocket.last.serverSends({ type: 'auth_invalid' });
        await expect(pending).rejects.toThrow('auth refused');
    });

    it('refuses to start without HA configuration', () => {
        vi.stubEnv('HA_ACCESS_TOKEN', '');
        expect(() => haWebSocketCommand(COMMAND, 'test')).toThrow('Missing HA_BASE_URL');
        vi.unstubAllEnvs();
    });
});
