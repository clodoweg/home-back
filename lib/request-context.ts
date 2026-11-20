/**
 * Request context — identifiant de la requête en cours, propagé sans le passer d'appel en appel.
 * withAuth opens the context; haClient reads it to send X-Request-Id to Home Assistant, so
 * one dashboard action can be followed from the front logs to the HA logs.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<{ requestId: string }>();

/**
 * Runs a function with a request id available to everything it awaits.
 *
 * @param requestId - Id of the incoming request.
 * @param fn - Work to run inside the context.
 * @returns The result of fn.
 */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
    return storage.run({ requestId }, fn);
}

/**
 * Id of the request being processed.
 *
 * @returns The request id, or undefined outside a request (cron, tests).
 */
export function getRequestId(): string | undefined {
    return storage.getStore()?.requestId;
}
