/** Request ID — identifiant de corrélation des logs, jamais repris brut du client */

/** A client-supplied request ID is only reused when it cannot forge log lines. */
const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Returns the client's request ID when it is safe to log, or a new one otherwise.
 *
 * @param clientRequestId - Value of the `x-request-id` header, if any.
 * @returns A request ID made of `[A-Za-z0-9_-]` only.
 */
export function resolveRequestId(clientRequestId: string | null | undefined): string {
    return clientRequestId && SAFE_REQUEST_ID_PATTERN.test(clientRequestId)
        ? clientRequestId
        : crypto.randomUUID().substring(0, 8);
}
