/**
 * Shared CORS configuration.
 * Single source of truth — used by both proxy.ts and withAuth.
 *
 * WARNING: the allowlist also feeds Clerk's `authorizedParties`. Extra development origins
 * are only accepted outside production builds.
 */
import { NextResponse } from 'next/server';

// Production serves the front only (audit L1): every origin here is also an authorized party for
// Clerk tokens, and a Clerk production instance does not serve localhost anyway. The Vite dev
// server talks to a local back (VITE_API_URL=http://localhost:3000).
const PRODUCTION_ORIGINS = ['https://home.psaltery.org'];

const DEVELOPMENT_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

export const ALLOWED_ORIGINS = new Set(
    process.env.NODE_ENV === 'production' ? PRODUCTION_ORIGINS : [...PRODUCTION_ORIGINS, ...DEVELOPMENT_ORIGINS],
);

/** Origins allowed to have issued a Clerk session token (`azp` claim). */
export const AUTHORIZED_PARTIES = [...ALLOWED_ORIGINS];

const CORS_METHODS = 'GET, POST, OPTIONS';
const CORS_HEADERS = 'Authorization, Content-Type, X-Request-Id';

/**
 * Builds the CORS headers for a request origin.
 *
 * @param origin - Value of the `Origin` request header ('' when absent).
 * @returns The headers to send, or an empty object when the origin is not allowed
 *          (no CORS header at all, so the browser blocks the response).
 */
export function buildCorsHeaders(origin: string): Record<string, string> {
    if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};

    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': CORS_METHODS,
        'Access-Control-Allow-Headers': CORS_HEADERS,
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
    };
}

/**
 * Copies CORS headers onto a response.
 *
 * @param res - Response to decorate.
 * @param corsHeaders - Headers built by `buildCorsHeaders`.
 * @returns The same response.
 */
export function applyCorsHeaders(res: NextResponse, corsHeaders: Record<string, string>): NextResponse {
    for (const [key, value] of Object.entries(corsHeaders)) {
        res.headers.set(key, value);
    }
    return res;
}
