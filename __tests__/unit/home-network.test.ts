import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const resolve4 = vi.fn();
const resolve6 = vi.fn();

vi.mock('dns', () => ({ promises: { resolve4, resolve6 }, default: { promises: { resolve4, resolve6 } } }));

/** Fresh module per test: the DDNS resolution is cached for 5 minutes. */
async function loadIsOnHomeNetwork() {
    vi.resetModules();
    return (await import('@/lib/permissions')).isOnHomeNetwork;
}

describe('isOnHomeNetwork — DDNS', () => {
    beforeEach(() => {
        vi.stubEnv('HOME_DDNS_HOSTNAME', 'home.ddns.example');
        resolve4.mockReset().mockResolvedValue(['198.51.100.20']);
        resolve6.mockReset().mockResolvedValue(['2a01:cb00:1:2::1']);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('resolves the hostname configured in HOME_DDNS_HOSTNAME', async () => {
        const isOnHomeNetwork = await loadIsOnHomeNetwork();
        await isOnHomeNetwork('198.51.100.20');
        expect(resolve4).toHaveBeenCalledWith('home.ddns.example');
        expect(resolve6).toHaveBeenCalledWith('home.ddns.example');
    });

    it('fails closed without HOME_DDNS_HOSTNAME, with no DNS lookup', async () => {
        vi.stubEnv('HOME_DDNS_HOSTNAME', '  ');
        const isOnHomeNetwork = await loadIsOnHomeNetwork();
        expect(await isOnHomeNetwork('198.51.100.20')).toBe(false);
        expect(await isOnHomeNetwork('192.168.1.42')).toBe(true);
        expect(resolve4).not.toHaveBeenCalled();
    });

    it('matches the public IPv4 resolved from the DDNS name', async () => {
        const isOnHomeNetwork = await loadIsOnHomeNetwork();
        expect(await isOnHomeNetwork('198.51.100.20')).toBe(true);
        expect(await isOnHomeNetwork('198.51.100.21')).toBe(false);
    });

    it('matches any address of the home /64, whatever its notation', async () => {
        const isOnHomeNetwork = await loadIsOnHomeNetwork();
        expect(await isOnHomeNetwork('2A01:CB00:0001:0002:abcd::5')).toBe(true);
        expect(await isOnHomeNetwork('2a01:cb00:1:3::5')).toBe(false);
    });

    it('treats an unknown IP as outside the home network', async () => {
        const isOnHomeNetwork = await loadIsOnHomeNetwork();
        expect(await isOnHomeNetwork('unknown')).toBe(false);
    });

    it('fails closed when the DDNS name does not resolve', async () => {
        resolve4.mockRejectedValue(new Error('ENOTFOUND'));
        resolve6.mockRejectedValue(new Error('ENOTFOUND'));
        const isOnHomeNetwork = await loadIsOnHomeNetwork();
        expect(await isOnHomeNetwork('198.51.100.20')).toBe(false);
    });

    it('fails closed when the resolver itself throws', async () => {
        // A synchronous throw escapes the per-call .catch and hits the outer guard: still false.
        resolve4.mockImplementation(() => { throw new Error('dns down'); });
        resolve6.mockResolvedValue([]);
        const isOnHomeNetwork = await loadIsOnHomeNetwork();
        expect(await isOnHomeNetwork('198.51.100.20')).toBe(false);
    });
});
