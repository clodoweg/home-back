/**
 * Environment Configuration
 * Single source of truth for environment variables.
 * Values are read via getters so tests can mutate process.env at runtime.
 */

/** Strip surrounding double-quotes and trim whitespace. */
const clean = (v: string | undefined): string =>
    (v || '').trim().replace(/^"(.*)"$/, '$1');

/** Live-bound environment values for Home Assistant. */
export const env = Object.freeze({
    get HA_BASE_URL(): string {
        return clean(process.env.HA_BASE_URL).replace(/\/+$/, '');
    },
    get HA_ACCESS_TOKEN(): string {
        return clean(process.env.HA_ACCESS_TOKEN);
    },
});

/**
 * Throws if HA configuration is missing. Call from routes that require HA.
 * @throws Error when HA_BASE_URL or HA_ACCESS_TOKEN is missing.
 */
export function assertHAConfig(): void {
    if (!env.HA_BASE_URL || !env.HA_ACCESS_TOKEN) {
        throw new Error('Missing HA_BASE_URL or HA_ACCESS_TOKEN env variables');
    }
}

/** Returns `true` when both HA env variables are present. */
export function hasHAConfig(): boolean {
    return !!env.HA_BASE_URL && !!env.HA_ACCESS_TOKEN;
}
