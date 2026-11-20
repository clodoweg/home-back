/** ESLint — flat config de l'API (Next 16 n'a plus `next lint`) */
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
    globalIgnores(['.next/**', 'coverage/**', 'node_modules/**', 'next-env.d.ts', 'prisma/migrations/**', 'lib/generated/**']),
    js.configs.recommended,
    ...tseslint.configs.recommended,
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
        },
    },
]);
