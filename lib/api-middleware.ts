/**
 * API Framework Middleware
 * Handles cross-cutting concerns: CORS, Logging, Rate Limiting, and multi-layer Authentication.
 * 
 * WARNING: This module is critical for security. Ensure any changes to authentication
 * or rate limiting logic are thoroughly reviewed.
 */
import { NextResponse } from 'next/server';
import { auth, verifyToken, clerkClient } from '@clerk/nextjs/server';
import { headers as nextHeaders } from 'next/headers';
import { getCachedUser, invalidateUserCache } from '@/lib/user-cache';
import { getOrCreateUser, type AuthUser } from '@/lib/user';
import { logger } from '@/lib/logger';
import { trackSecurityEvent } from '@/lib/security-alerts';
import { isOnHomeNetwork } from '@/lib/permissions';
import { ApiResponse } from '@/lib/api-response';
import { apiRatelimit, strictRatelimit, imageRatelimit, checkRateLimit } from '@/lib/ratelimit';
import { buildCorsHeaders, applyCorsHeaders, AUTHORIZED_PARTIES } from '@/lib/cors';
import { getClientIp } from '@/lib/client-ip';
import { resolveRequestId } from '@/lib/request-id';
import { runWithRequestId } from '@/lib/request-context';

import { isApiEnabled } from '@/lib/settings';

type AuthorizedHandler<P> = (
    request: Request,
    context: {
        params: Promise<P>;
        user: AuthUser;
        userId: string;
        userEmail: string;
    }
) => Promise<NextResponse>;

/**
 * Primary email of a Clerk user, used when provisioning a user whose token has no email.
 *
 * @param userId - Clerk user id.
 * @returns The email, or a synthetic `user-<id>` when Clerk has none or cannot be reached.
 */
async function fetchClerkEmail(userId: string): Promise<string> {
    try {
        const client = await clerkClient();
        const clerkUser = await client.users.getUser(userId);
        return clerkUser.primaryEmailAddress?.emailAddress || clerkUser.emailAddresses?.[0]?.emailAddress || `user-${userId}`;
    } catch {
        return `user-${userId}`;
    }
}

/**
 * Enhanced Higher-Order Function to wrap API routes with multi-layer security.
 * 
 * @param handler - The downstream route handler function, typed on its route params `P`.
 * @returns An authenticated and instrumented API handler.
 */
export function withAuth<P = Record<string, string | string[] | undefined>>(handler: AuthorizedHandler<P>) {
    return async (request: Request, { params }: { params: Promise<P> }) => {
        const start = Date.now();
        const method = request.method;
        const url = new URL(request.url);
        const path = url.pathname;

        // Generate or retrieve Request ID
        let requestId = 'unknown';
        let ip = 'unknown';
        let origin = '';

        try {
            const currentHeaders = await nextHeaders();
            requestId = resolveRequestId(currentHeaders.get('x-request-id'));
            origin = currentHeaders.get('origin') || '';
            ip = getClientIp(currentHeaders);
        } catch {
            // Context-sensitive headers might fail in some environments
        }

        const corsHeaders = buildCorsHeaders(origin);

        const applyCors = (res: NextResponse) => applyCorsHeaders(res, corsHeaders);

        // 🟢 Check if API is enabled globally
        const apiEnabled = await isApiEnabled();
        if (!apiEnabled) {
            logger.warn('API deactivated via SystemSettings', { requestId, path, method });
            const response = applyCors(ApiResponse.error("API disabled by system settings", 503, undefined, 'API_DISABLED'));

            return response;
        }

        const isSensitive = path.includes('/call') || path.includes('snapshot');
        const isImage = path.includes('image') || path.includes('/ha/media');
        const limiter = isSensitive ? strictRatelimit : (isImage ? imageRatelimit : apiRatelimit);

        const tooManyRequests = () => {
            logger.rateLimit({ requestId, method, path, ip });
            const response = applyCors(ApiResponse.error('Too Many Requests', 429, undefined, 'RATE_LIMITED'));
            response.headers.set('Retry-After', '60');
            response.headers.set('X-RateLimit-Remaining', '0');
            return response;
        };

        const rateLimitResult = await checkRateLimit(limiter, ip);
        if (!rateLimitResult.success) return tooManyRequests();

        logger.apiRequest({ requestId, method, path, ip });

        try {
            let userId = null;
            let sessionClaims: Record<string, unknown> | null = null;

            try {
                // Attempt standard Clerk auth
                const authResult = await auth();
                userId = authResult.userId;
                sessionClaims = authResult.sessionClaims as Record<string, unknown> | null;
            } catch (clerkError) {
                // If Clerk throws "clerkMiddleware() not detected", we don't crash, we fall back
                if (String(clerkError).includes('clerkMiddleware')) {
                    logger.warn('Clerk middleware not detected by auth(), falling back to manual verification', { requestId });
                } else {
                    throw clerkError; // Rethrow if it's another type of error
                }
            }

            // FALLBACK: If auth() returns no userId (proxy.ts not run, or no session cookie),
            // attempt manual verification of the Bearer header. Tokens in the query string
            // are refused: URLs end up in Cloudflare/Vercel logs and browser history.
            if (!userId) {
                const match = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
                const bearerToken = match ? match[1] : null;

                if (bearerToken) {
                    const secretKey = (process.env.CLERK_SECRET_KEY || '').trim().replace(/^"(.*)"$/, '$1');
                    if (!secretKey) {
                        logger.error('CLERK_SECRET_KEY is not configured', { requestId });
                    }
                    try {
                        const claims = await verifyToken(bearerToken, { secretKey, authorizedParties: AUTHORIZED_PARTIES });

                        if (claims && (claims.sub || claims.userId)) {
                            userId = claims.sub || (claims.userId as string);
                            sessionClaims = claims as Record<string, unknown>;
                        } else {
                            logger.warn('Manual token verification: missing sub/userId', { requestId });
                        }
                    } catch (verifyError) {
                        logger.error('Manual token verification failed', {
                            requestId,
                            path,
                            message: verifyError instanceof Error ? verifyError.message : String(verifyError),
                            hasSecret: !!secretKey,
                        });
                    }
                } else {
                    logger.debug('No token found', { requestId, path });
                }
            }

            if (!userId) {
                await trackSecurityEvent({
                    type: 'auth_failure',
                    ip,
                    requestId,
                    details: 'No userId in token (even after fallback)',
                });
                logger.security('Authentication failed: no userId', { requestId, ip });
                const response = applyCors(ApiResponse.unauthorized());

                return response;
            }

            let dbUser = await getCachedUser(userId);
            let email = (sessionClaims?.email as string | undefined) ||
                (sessionClaims?.primary_email as string | undefined) ||
                dbUser?.email ||
                '';

            if (!dbUser) {
                // Clerk session tokens carry no email by default: the Clerk API is only called
                // to provision a new user, never on every request
                if (!email) email = await fetchClerkEmail(userId);
                try {
                    dbUser = await getOrCreateUser(userId, email);
                    invalidateUserCache(userId);
                    logger.info(`✅ Auto-provisioned user ${email} (${userId}) as ${dbUser.group}`, { requestId });
                } catch (provisionError) {
                    logger.error('Auto-provisioning failed', { requestId, userId, email, error: String(provisionError) });
                    const response = applyCors(ApiResponse.error("Utilisateur non autorisé", 403, undefined, 'USER_NOT_FOUND'));
                    return response;
                }
            }

            const permissions = dbUser.userGroup?.permissions || [];
            if (!permissions.includes('remote')) {
                const homeNetwork = await isOnHomeNetwork(ip);
                if (!homeNetwork) {
                    logger.security(`🛡️ Blocked remote access for ${email} from IP ${ip}`, { requestId, ip, userEmail: email });
                    const response = applyCors(ApiResponse.error('Forbidden: Access restricted to Home WiFi.', 403, undefined, 'IP_RESTRICTED'));

                    return response;
                }
            }

            // Sensitive routes (HA service calls, snapshots) are also limited per user, whatever the IP
            if (isSensitive && !(await checkRateLimit(strictRatelimit, `user:${userId}`)).success) {
                return tooManyRequests();
            }

            const response = await runWithRequestId(requestId, () => handler(request, {
                params,
                user: dbUser,
                userId,
                userEmail: email,
            }));

            const durationMs = Date.now() - start;
            logger.apiResponse({ requestId, method, path, durationMs, status: response.status });

            response.headers.set('X-Response-Time', `${durationMs}ms`);
            response.headers.set('X-Request-Id', requestId);


            return applyCors(response);

        } catch (error) {
            const durationMs = Date.now() - start;
            // Handle specific database errors (connection pool, quota)
            const errorStr = String(error);
            if (errorStr.includes('quota exceeded') || errorStr.includes('limit reached') || errorStr.includes('too many connections')) {
                logger.error('Database Quota Exceeded', { requestId, error: errorStr });
                const response = applyCors(ApiResponse.error('Service temporarily unavailable', 503, undefined, 'SERVICE_UNAVAILABLE'));

                return response;
            }

            logger.error('Unhandled error in API handler', { requestId, path, durationMs, error: errorStr });
            const response = applyCors(ApiResponse.serverError());
            
            return response;
        }
    };
}
