/** Origin guard — refuse en production les requêtes qui n'ont pas traversé Cloudflare */
import { ApiResponse } from './api-response';
import { getOriginSecretStatus } from './client-ip';
import { logger } from './logger';

let hasReportedMissingSecret = false;

/**
 * WARNING: the production domain stays reachable at Vercel's edge without going through Cloudflare
 * (and its protections). A request that went through our zone carries `x-origin-secret`, injected by
 * a Cloudflare Request Header Transform Rule. A Vercel Firewall rule making this same check denied
 * every request, although the header does reach the functions (November 2026): the check lives here.
 *
 * Two modes, so that a broken Cloudflare rule never takes the API down unnoticed:
 * - observe (default): every production request is logged as `Origin check ok` / `missing` /
 *   `mismatch`, nothing is refused;
 * - enforce (`ENFORCE_ORIGIN_SECRET=true`): requests without the right secret get a 403.
 * Outside Vercel production (local, preview deployments reached directly), nothing is checked.
 *
 * @param request - Incoming request.
 * @returns A 403 response to send instead of handling the request, or null to go on.
 */
export function guardOrigin(request: Request): Response | null {
    if (process.env.VERCEL_ENV !== 'production') return null;

    const status = getOriginSecretStatus(request.headers);
    if (status === 'unconfigured') {
        // Fails open: without the secret, refusing everything would take the whole API down
        if (!hasReportedMissingSecret) {
            hasReportedMissingSecret = true;
            logger.error('Origin check skipped: CF_ORIGIN_SECRET is not set');
        }
        return null;
    }

    const isEnforced = process.env.ENFORCE_ORIGIN_SECRET === 'true';
    const context = { path: new URL(request.url).pathname, enforced: isEnforced, event: 'origin_check' };

    if (status === 'ok') {
        if (!isEnforced) logger.debug('Origin check ok', context);
        return null;
    }

    logger.warn(`Origin check ${status}`, context);
    return isEnforced ? ApiResponse.error('Forbidden', 403, undefined, 'ORIGIN_FORBIDDEN') : null;
}

/** Forgets that a missing CF_ORIGIN_SECRET was reported (tests). */
export function resetOriginGuardReport(): void {
    hasReportedMissingSecret = false;
}
