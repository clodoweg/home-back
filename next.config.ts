import type { NextConfig } from "next";

// Single source of security headers (vercel.json defines none, to avoid divergent duplicates)
const securityHeaders = [
    // Force HTTPS for 2 years + include subdomains
    { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
    // Prevent MIME type sniffing
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    // Pure JSON/image API: nothing may be loaded, executed or framed from its responses
    { key: 'Content-Security-Policy', value: "default-src 'none'; frame-ancestors 'none'" },
    // Legacy equivalent of frame-ancestors for older browsers
    { key: 'X-Frame-Options', value: 'DENY' },
    // Control referrer information
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    // Disable access to browser features
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig: NextConfig = {
    poweredByHeader: false,
    // CORS is handled dynamically in middleware.ts with a strict allowlist
    async headers() {
        return [
            {
                // Apply security headers to all routes
                source: '/:path*',
                headers: [
                    ...securityHeaders,
                ],
            },
        ];
    },
    turbopack: {
        root: __dirname,
    },
    experimental: {
        // other experimental options can go here if needed
    },
};

export default nextConfig;
