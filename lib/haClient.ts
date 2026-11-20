/**
 * Home Assistant API Client
 * Provides a timed and instrumented fetch wrapper for HA REST API calls.
 * 
 * WARNING: Handles sensitive API tokens. Do not log raw headers or sensitive data.
 */

import { logger } from '@/lib/logger';
import { env, assertHAConfig } from '@/lib/env';
import { getRequestId } from '@/lib/request-context';

/** Home Assistant entity state, as returned by /api/states and /api/history. */
export interface HAState {
    entity_id: string;
    state: string;
    last_changed?: string;
    last_updated?: string;
    attributes?: Record<string, unknown>;
}

interface HAFetchOptions {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: object;
    /** Label for logging (e.g., 'history', 'states') */
    label?: string;
    /** Request ID for tracing; defaults to the id of the request being processed */
    requestId?: string;
    /** Aborts the call early (e.g. when a concurrent probe already succeeded) */
    signal?: AbortSignal;
    /** A 404 is an expected outcome (path probing): logged at debug level only */
    expectMiss?: boolean;
}

interface HAFetchResult<T> {
    data: T;
    /** Response time in milliseconds */
    duration: number;
    ok: boolean;
    status: number;
}

/**
 * WARNING: performance-critical. Vercel Hobby functions may be capped at 60 s (300 s with
 * Fluid compute): a call that does not answer within this delay fails instead of retrying,
 * so a slow HA never keeps a function alive for a minute.
 */
export const HA_TIMEOUT_MS = 10_000;

/**
 * Resolves an HA path, or an absolute URL that must stay on the HA origin: the HA admin
 * token is attached to every call and must never reach another host.
 */
function resolveHaUrl(path: string): { url: string; displayPath: string } {
    if (!path.startsWith('http')) return { url: `${env.HA_BASE_URL}${path}`, displayPath: path };
    const target = new URL(path);
    if (target.origin !== new URL(env.HA_BASE_URL).origin) {
        throw new Error('Refusing to send the HA token outside the HA origin');
    }
    return { url: target.toString(), displayPath: target.pathname };
}

/**
 * Runs a request against HA with the token, the request id and a timeout that also covers
 * the reading of the body.
 */
async function requestHa<R>(
    path: string,
    options: HAFetchOptions,
    read: (response: Response) => Promise<R>,
): Promise<{ response: Response; result: R | null; duration: number; requestId: string; displayPath: string }> {
    const { method = 'GET', body, label, signal } = options;
    assertHAConfig();
    const { url, displayPath } = resolveHaUrl(path);
    const requestId = options.requestId || getRequestId() || 'no-id';

    logger.haCall({ requestId, haMethod: method, haPath: displayPath, label });

    const start = Date.now();
    const timeoutSignal = AbortSignal.timeout(HA_TIMEOUT_MS);
    const response = await fetch(url, {
        method,
        headers: {
            'Authorization': `Bearer ${env.HA_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
            'X-Request-Id': requestId,
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        signal: signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal,
    });
    const result = response.ok ? await read(response) : null;
    return { response, result, duration: Date.now() - start, requestId, displayPath };
}

const isTimeoutError = (error: unknown) =>
    error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');

/** undici reports connection failures ("fetch failed", "terminated") as TypeError. */
const isNetworkError = (error: unknown) => error instanceof TypeError;

/**
 * Fetches data from Home Assistant API with timing instrumentation.
 *
 * @param path - The API endpoint relative to HA_BASE_URL (or a full URL on the HA origin).
 * @param options - Fetch options including method, body, and logging label.
 * @param _retried - Internal flag to prevent infinite retry loops.
 * @returns Result object containing typed data, timing, and response status.
 */
export async function haFetch<T = unknown>(
    path: string,
    options: HAFetchOptions = {},
    _retried = false,
): Promise<HAFetchResult<T>> {
    const method = options.method || 'GET';
    const start = Date.now();
    // Outside the try: a refused off-origin URL is a programming error, never retried
    resolveHaUrl(path);

    try {
        const { response, result, duration, requestId, displayPath } = await requestHa(path, options, async (res) => {
            const contentType = res.headers.get('content-type') || '';
            return (contentType.includes('application/json') ? await res.json() : await res.text()) as T;
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            logger.error('Home Assistant API error', {
                requestId,
                haPath: displayPath,
                haMethod: method,
                status: response.status,
                durationMs: duration,
                errorBody: errorText.substring(0, 200),
            });
            return { data: null as T, duration, ok: false, status: response.status };
        }

        logger.debug('Home Assistant API success', { requestId, haPath: displayPath, haMethod: method, durationMs: duration });
        return { data: result as T, duration, ok: true, status: response.status };
    } catch (error) {
        const duration = Date.now() - start;
        const errorMessage = error instanceof Error ? error.message : String(error);
        const context = { requestId: options.requestId || getRequestId() || 'no-id', haPath: path, haMethod: method, durationMs: duration };

        // A single retry, for GET only and only on a transient network error: retrying a
        // timeout would double the wait of an already slow HA, and an invalid body stays invalid.
        if (!_retried && method === 'GET' && isNetworkError(error) && !options.signal?.aborted) {
            logger.warn('Home Assistant API retry', { ...context, reason: errorMessage });
            return haFetch<T>(path, options, true);
        }

        logger.error('Home Assistant API failed', { ...context, error: isTimeoutError(error) ? 'timeout' : errorMessage });
        throw error;
    }
}

/** Binary HA response (camera images, media). */
export interface HABinaryResult {
    ok: boolean;
    status: number;
    contentType: string | null;
    bytes: Uint8Array<ArrayBuffer> | null;
}

/**
 * Fetches binary content (camera snapshot, image entity, media file) from Home Assistant,
 * with the same token, origin check and timeout as haFetch. No retry: images are refreshed
 * by the next poll anyway.
 *
 * @param path - HA path or full URL on the HA origin.
 * @param options - Logging label, request id, abort signal.
 * @returns The bytes and content type, or ok=false with the HA status.
 * @throws On network error or timeout.
 */
export async function haFetchBinary(path: string, options: Omit<HAFetchOptions, 'method' | 'body'> = {}): Promise<HABinaryResult> {
    const { response, result, duration, requestId, displayPath } = await requestHa(
        path,
        { ...options, method: 'GET' },
        async (res) => new Uint8Array(await res.arrayBuffer()),
    );
    if (!response.ok) {
        // Release the connection now rather than at the timeout
        await response.body?.cancel().catch(() => {});
        const log = options.expectMiss && response.status === 404 ? logger.debug : logger.warn;
        log('Home Assistant binary fetch failed', { requestId, haPath: displayPath, status: response.status, durationMs: duration });
    }
    return { ok: response.ok, status: response.status, contentType: response.headers.get('content-type'), bytes: result };
}

/**
 * Convenience wrapper for GET requests.
 *
 * @param path - The API endpoint path.
 * @param label - Optional label for logging context.
 * @param requestId - Optional request ID for tracing.
 * @returns Typed result of the GET request.
 */
export async function haGet<T = unknown>(path: string, label?: string, requestId?: string): Promise<HAFetchResult<T>> {
    return haFetch<T>(path, { method: 'GET', label, requestId });
}

/**
 * Convenience wrapper for POST requests.
 *
 * @param path - The API endpoint path.
 * @param body - JSON-serializable request body.
 * @param label - Optional label for logging context.
 * @param requestId - Optional request ID for tracing.
 * @returns Typed result of the POST request.
 */
export async function haPost<T = unknown>(path: string, body: object, label?: string, requestId?: string): Promise<HAFetchResult<T>> {
    return haFetch<T>(path, { method: 'POST', body, label, requestId });
}
