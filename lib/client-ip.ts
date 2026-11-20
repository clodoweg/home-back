/**
 * Client IP — résolution de l'IP cliente derrière Cloudflare et Vercel.
 *
 * WARNING: the home-network restriction and the rate limiter both rely on this value.
 * `cf-connecting-ip` is only trusted when the request carries the origin secret that a
 * Cloudflare Transform Rule injects: anyone can call the `*.vercel.app` origin directly
 * and forge that header otherwise.
 */
import { safeCompare } from './secure-compare';
import { logger } from './logger';

export const ORIGIN_SECRET_HEADER = 'x-origin-secret';

/**
 * Tells whether the request went through our Cloudflare zone.
 *
 * @param headers - Incoming request headers.
 * @returns true when `x-origin-secret` matches `CF_ORIGIN_SECRET`.
 */
export function isFromCloudflare(headers: Pick<Headers, 'get'>): boolean {
    const originSecret = process.env.CF_ORIGIN_SECRET;
    if (!originSecret) return false;
    return safeCompare(headers.get(ORIGIN_SECRET_HEADER) ?? '', originSecret);
}

/**
 * Resolves the client IP of a request.
 * Behind Cloudflare, `cf-connecting-ip` is the real client. Otherwise we fall back on
 * the headers Vercel overwrites itself (`x-real-ip`, `x-forwarded-for`): a direct call
 * to the origin then yields the caller's own public IP, never a forged one.
 *
 * @param headers - Incoming request headers.
 * @returns The normalized IP, or 'unknown' when none is available.
 */
export function getClientIp(headers: Pick<Headers, 'get'>): string {
    const cloudflareIp = headers.get('cf-connecting-ip');
    if (cloudflareIp) {
        if (isFromCloudflare(headers)) return normalizeIp(cloudflareIp);
        // Either a direct call to the origin with a forged header, or a broken Cloudflare
        // rule / missing CF_ORIGIN_SECRET: the latter blocks every non-remote user
        logger.warn('cf-connecting-ip ignored: Cloudflare origin secret missing or invalid');
    }

    const platformIp = headers.get('x-real-ip') || headers.get('x-forwarded-for')?.split(',')[0];
    return platformIp?.trim() ? normalizeIp(platformIp) : 'unknown';
}

/**
 * Normalizes an IP address: trims it, lowercases it and unwraps IPv4-mapped IPv6.
 *
 * @param ip - Raw IP address.
 * @returns The normalized address.
 */
export function normalizeIp(ip: string): string {
    return ip.trim().toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
}

/**
 * Expands an IPv6 address into its 8 zero-padded groups, so that compressed (`::`)
 * and uppercase forms compare equal.
 *
 * @param address - IPv6 address, possibly compressed.
 * @returns The 8 groups, or null when the address is not a plain IPv6.
 */
export function expandIpv6(address: string): string[] | null {
    const lower = address.toLowerCase().split('%')[0];
    if (!lower.includes(':')) return null;

    const halves = lower.split('::');
    if (halves.length > 2) return null;

    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const missingGroups = 8 - head.length - tail.length;
    if (halves.length === 1 ? missingGroups !== 0 : missingGroups < 1) return null;

    const groups = [...head, ...Array<string>(halves.length === 2 ? missingGroups : 0).fill('0'), ...tail];
    if (groups.some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;
    return groups.map(group => group.padStart(4, '0'));
}

/**
 * Tells whether two IPv6 addresses share the same /64 prefix.
 *
 * @param a - First IPv6 address.
 * @param b - Second IPv6 address.
 * @returns true when their first 64 bits are identical.
 */
export function isSameIpv6Prefix64(a: string, b: string): boolean {
    const groupsA = expandIpv6(a);
    const groupsB = expandIpv6(b);
    if (!groupsA || !groupsB) return false;
    return groupsA.slice(0, 4).join(':') === groupsB.slice(0, 4).join(':');
}
