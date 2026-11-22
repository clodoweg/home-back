import { defineConfig } from 'vitest/config';
import path from 'path';

// Tests run in UTC like Vercel, so date logic behaves as in production whatever the machine
process.env.TZ = 'UTC';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        setupFiles: ['./__tests__/setup.ts'],
        include: ['__tests__/**/*.test.ts'],
        reporters: ['default', './__tests__/summary-reporter.ts'],
        coverage: {
            provider: 'v8',
            include: ['lib/**', 'app/api/**', 'proxy.ts'],
            exclude: ['node_modules', '.next', 'prisma/migrations', 'lib/generated/**'],
            // Blocking thresholds (audit lot 2): 80 % overall, ~95 % on the security perimeter.
            // Each key is a single file: Vitest sums every file matched by a glob key.
            thresholds: {
                lines: 80,
                branches: 80,
                functions: 80,
                statements: 80,
                ...Object.fromEntries(
                    [
                        'lib/api-middleware.ts',
                        'lib/permissions.ts',
                        'lib/validators.ts',
                        'lib/cors.ts',
                        'lib/client-ip.ts',
                        'lib/ha-paths.ts',
                        'lib/secure-compare.ts',
                        'lib/request-id.ts',
                        'lib/user.ts',
                        'lib/ha-state-filter.ts',
                        'lib/ratelimit.ts',
                        'lib/origin-guard.ts',
                        'proxy.ts',
                        'app/api/cron/route.ts',
                    ].map(path => [path, { lines: 95, branches: 95, functions: 95, statements: 95 }]),
                ),
            },
        },
    },
    resolve: {
        alias: {
            '@': path.resolve(import.meta.dirname, '.'),
            '@/lib': path.resolve(import.meta.dirname, './lib'),
            '@/app': path.resolve(import.meta.dirname, './app'),
        },
    },
});
