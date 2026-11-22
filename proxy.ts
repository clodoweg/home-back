/**
 * Global API Proxy (Next 16 name of the former middleware.ts)
 * Checks that the request came through Cloudflare, then handles CORS and Clerk Authentication
 * for all incoming requests.
 *
 * WARNING: This is a critical security layer. Verify CORS allowlists and Auth rules.
 */
import { clerkMiddleware } from '@clerk/nextjs/server';
import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server';
import { AUTHORIZED_PARTIES, buildCorsHeaders } from '@/lib/cors';
import { guardOrigin } from '@/lib/origin-guard';

const clerkProxy = clerkMiddleware(async (auth, request) => {
    // A refused origin gets no CORS header at all, so the browser blocks the response
    const corsHeaders = buildCorsHeaders(request.headers.get('origin') || '');

    // Handle CORS Preflight
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: corsHeaders,
        });
    }

    const response = NextResponse.next();

    Object.entries(corsHeaders).forEach(([key, value]) => {
        response.headers.set(key, value);
    });

    return response;
}, { authorizedParties: AUTHORIZED_PARTIES });

/**
 * Runs before every route: the origin check first (a request that bypassed Cloudflare gets
 * neither Clerk work nor CORS headers), then Clerk and CORS.
 *
 * @param request - Incoming request.
 * @param event - Fetch event, passed on to Clerk.
 * @returns The 403 of the origin check, or Clerk's result.
 */
export default function proxy(request: NextRequest, event: NextFetchEvent) {
    return guardOrigin(request) ?? clerkProxy(request, event);
}

export const config = {
    matcher: [
        // Skip Next.js internals and all static files, unless found in search params
        '/((?!_next|[^?]*\\.(?:html|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
        // Always run for API routes
        '/(api|trpc)(.*)',
    ],
};
