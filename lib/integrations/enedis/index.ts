/**
 * Enedis Integration Entry Point
 * Public API: reading the stored series and synchronizing them. The raw API client stays internal.
 */
export * from './types';
export { syncEnedisData } from './sync';
export { getEnedisData } from './service';
