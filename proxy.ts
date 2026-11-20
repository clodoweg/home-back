/**
 * Global API Proxy (Next 16 name of the former middleware.ts)
 * Handles CORS and Clerk Authentication for all incoming requests.
 * 
 * WARNING: This is a critical security layer. Verify CORS allowlists and Auth rules.
 */
import { clerkMiddleware } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { AUTHORIZED_PARTIES, buildCorsHeaders } from '@/lib/cors';

export default clerkMiddleware(async (auth, request) => {
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

export const config = {
    matcher: [
        // Skip Next.js internals and all static files, unless found in search params
        '/((?!_next|[^?]*\\.(?:html|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
        // Always run for API routes
        '/(api|trpc)(.*)',
    ],
};
