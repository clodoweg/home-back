/**
 * HA WebSocket — une commande ponctuelle sur l'API WebSocket de Home Assistant.
 *
 * Some HA data is only exposed over the WebSocket API, notably the recorder's long-term
 * statistics (`recorder/statistics_during_period`): the REST history stops at the recorder's
 * purge (10 days by default). Each call opens a connection, authenticates, sends one command and
 * closes: a serverless function cannot keep a connection open between requests.
 *
 * WARNING: carries the HA admin token. The URL is always derived from HA_BASE_URL, never from
 * client input, and the token is only sent in the auth message, never logged.
 */
import { env, assertHAConfig } from '@/lib/env';
import { logger } from '@/lib/logger';

/** Same budget as the REST calls (`HA_TIMEOUT_MS`), for the whole exchange. */
export const HA_WS_TIMEOUT_MS = 10_000;

/** Error raised when HA refuses the command or the exchange fails. */
export class HAWebSocketError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'HAWebSocketError';
    }
}

/**
 * WebSocket URL of the HA instance: `https://ha.example` → `wss://ha.example/api/websocket`.
 *
 * @returns The URL of HA's WebSocket API.
 */
export function haWebSocketUrl(): string {
    const url = new URL(`${env.HA_BASE_URL}/api/websocket`);
    url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
    return url.toString();
}

interface HAMessage {
    id?: number;
    type: string;
    success?: boolean;
    result?: unknown;
    error?: { code?: string; message?: string };
}

const COMMAND_ID = 1;

/**
 * Sends one command over HA's WebSocket API and resolves with its result.
 *
 * @param command - Command without its `id` (e.g. `{ type: 'recorder/statistics_during_period', … }`).
 * @param label - Label for the logs.
 * @returns The `result` field of HA's answer.
 * @throws HAWebSocketError when HA refuses the token or the command, on timeout or connection loss.
 */
export function haWebSocketCommand<T>(command: { type: string } & Record<string, unknown>, label: string): Promise<T> {
    assertHAConfig();
    const started = Date.now();

    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const socket = new WebSocket(haWebSocketUrl());

        const finish = (error: HAWebSocketError | null, result?: T) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try {
                socket.close();
            } catch {
                // Already closed: nothing to release.
            }
            const durationMs = Date.now() - started;
            if (error) {
                logger.error('Home Assistant WebSocket failed', { label, durationMs, error: error.message });
                reject(error);
            } else {
                logger.debug('Home Assistant WebSocket success', { label, durationMs });
                resolve(result as T);
            }
        };

        const timer = setTimeout(() => finish(new HAWebSocketError('timeout')), HA_WS_TIMEOUT_MS);

        socket.addEventListener('message', (event: MessageEvent) => {
            let message: HAMessage;
            try {
                message = JSON.parse(String(event.data)) as HAMessage;
            } catch {
                finish(new HAWebSocketError('invalid message'));
                return;
            }
            if (message.type === 'auth_required') {
                socket.send(JSON.stringify({ type: 'auth', access_token: env.HA_ACCESS_TOKEN }));
            } else if (message.type === 'auth_ok') {
                socket.send(JSON.stringify({ ...command, id: COMMAND_ID }));
            } else if (message.type === 'auth_invalid') {
                finish(new HAWebSocketError('auth refused'));
            } else if (message.type === 'result' && message.id === COMMAND_ID) {
                if (message.success) finish(null, message.result as T);
                else finish(new HAWebSocketError(message.error?.message || message.error?.code || 'command refused'));
            }
        });
        socket.addEventListener('error', () => finish(new HAWebSocketError('connection error')));
        socket.addEventListener('close', () => finish(new HAWebSocketError('connection closed')));
    });
}
