/** Secure compare — comparaison de secrets à temps constant */
import { createHash, timingSafeEqual } from 'crypto';

/**
 * Compares a provided secret with the expected one in constant time.
 * Both values are hashed first so that neither their content nor their length
 * can be inferred from the comparison time.
 *
 * @param provided - Value received from the client (header, token…).
 * @param expected - Secret configured on the server.
 * @returns true when both values are identical.
 */
export function safeCompare(provided: string, expected: string): boolean {
    const providedDigest = createHash('sha256').update(provided).digest();
    const expectedDigest = createHash('sha256').update(expected).digest();
    return timingSafeEqual(providedDigest, expectedDigest);
}
