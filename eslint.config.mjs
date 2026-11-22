/** ESLint — flat config de l'API (Next 16 n'a plus `next lint`) */
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import sonarjs from 'eslint-plugin-sonarjs';
import tseslint from 'typescript-eslint';

// WARNING: known debt, not an allowance. Functions above the cognitive complexity threshold (15)
// when sonarjs was adopted (November 2026): each file keeps its worst score as a ceiling, so it
// cannot get worse. Lower or remove an entry when its file is refactored; never raise one.
const COGNITIVE_COMPLEXITY_BASELINE = {
    'app/api/cron/route.ts': 17,
    'app/api/ha/media/route.ts': 21,
    'app/api/user/preferences/route.ts': 19,
    'lib/api-middleware.ts': 52,
    'lib/ha-paths.ts': 20,
    'lib/integrations/alerts/detector.ts': 24,
    'lib/integrations/alerts/index.ts': 19,
    'lib/integrations/daily-usage/compute.ts': 33,
    'lib/integrations/daily-usage/service.ts': 17,
    'lib/integrations/grdf/service.ts': 51,
    'lib/integrations/petkit/feeder.ts': 38,
    'lib/integrations/petkit/fountain.ts': 27,
    'lib/integrations/suez/service.ts': 24,
};

export default defineConfig([
    globalIgnores(['.next/**', 'coverage/**', 'node_modules/**', 'next-env.d.ts', 'prisma/migrations/**', 'lib/generated/**']),
    js.configs.recommended,
    ...tseslint.configs.recommended,
    sonarjs.configs.recommended,
    {
        rules: {
            // Null checks on data from third-party APIs (Suez, HA) are deliberate guards, even
            // where the declared types say the value is always there.
            'sonarjs/different-types-comparison': 'off',
            // `TODO: [action]` is required by .claude/rules/code-comments.md.
            'sonarjs/todo-tag': 'off',
            // Nested ternaries are accepted, as in the front.
            'sonarjs/no-nested-conditional': 'off',
        },
    },
    ...Object.entries(COGNITIVE_COMPLEXITY_BASELINE).map(([file, ceiling]) => ({
        files: [file],
        rules: { 'sonarjs/cognitive-complexity': ['error', ceiling] },
    })),
    {
        files: ['**/*.ts'],
        languageOptions: {
            parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
        },
        rules: {
            // An un-awaited promise in a serverless function may never run before the response
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-misused-promises': 'error',
            '@typescript-eslint/await-thenable': 'error',
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            // Structured logs only (lib/logger.ts)
            'no-console': 'error',
        },
    },
    {
        files: ['lib/logger.ts'],
        rules: { 'no-console': 'off' },
    },
    {
        // Mocks and fixtures stay loosely typed
        files: ['__tests__/**/*.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-floating-promises': 'off',
            // Fake hosts, plain-http fixtures and exact expected numbers are what tests are for.
            'sonarjs/no-clear-text-protocols': 'off',
            'sonarjs/no-floating-point-equality': 'off',
            'sonarjs/no-hardcoded-ip': 'off',
            // Test doubles mirror browser APIs (a mutable static `last` instance).
            'sonarjs/public-static-readonly': 'off',
        },
    },
]);
