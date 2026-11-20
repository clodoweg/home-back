import { describe, it, expect, afterEach } from 'vitest';
import { expandIpv6, getClientIp, isFromCloudflare, isSameIpv6Prefix64, normalizeIp } from '@/lib/client-ip';
import { safeCompare } from '@/lib/secure-compare';

const ORIGIN_SECRET = 'cf_origin_test_secret';

describe('getClientIp', () => {
    afterEach(() => {
        delete process.env.CF_ORIGIN_SECRET;
    });

    it('trusts cf-connecting-ip when the Cloudflare origin secret matches', () => {
        process.env.CF_ORIGIN_SECRET = ORIGIN_SECRET;
        const headers = new Headers({
            'cf-connecting-ip': '203.0.113.7',
            'x-origin-secret': ORIGIN_SECRET,
            'x-real-ip': '172.70.1.1',
        });
        expect(getClientIp(headers)).toBe('203.0.113.7');
    });

    it('ignores a forged cf-connecting-ip sent straight to the Vercel origin', () => {
        process.env.CF_ORIGIN_SECRET = ORIGIN_SECRET;
        const headers = new Headers({
            'cf-connecting-ip': '192.168.1.10',
            'x-real-ip': '198.51.100.4',
            'x-forwarded-for': '198.51.100.4',
        });
        expect(getClientIp(headers)).toBe('198.51.100.4');
    });

    it('ignores cf-connecting-ip when the origin secret is wrong', () => {
        process.env.CF_ORIGIN_SECRET = ORIGIN_SECRET;
        const headers = new Headers({
            'cf-connecting-ip': '192.168.1.10',
            'x-origin-secret': 'guess',
            'x-real-ip': '198.51.100.4',
        });
        expect(getClientIp(headers)).toBe('198.51.100.4');
    });

    it('ignores cf-connecting-ip when no origin secret is configured', () => {
        const headers = new Headers({ 'cf-connecting-ip': '192.168.1.10', 'x-origin-secret': '' });
        expect(getClientIp(headers)).toBe('unknown');
    });

    it('falls back on the first x-forwarded-for hop, then on unknown', () => {
        expect(getClientIp(new Headers({ 'x-forwarded-for': ' 198.51.100.4 , 10.0.0.1' }))).toBe('198.51.100.4');
        expect(getClientIp(new Headers())).toBe('unknown');
    });

    it('unwraps IPv4-mapped IPv6 addresses', () => {
        expect(getClientIp(new Headers({ 'x-real-ip': '::ffff:192.168.1.10' }))).toBe('192.168.1.10');
    });
});

describe('isFromCloudflare', () => {
    afterEach(() => {
        delete process.env.CF_ORIGIN_SECRET;
    });

    it('is false without a configured secret, even if the header is empty', () => {
        expect(isFromCloudflare(new Headers({ 'x-origin-secret': '' }))).toBe(false);
    });
});

describe('normalizeIp', () => {
    it('lowercases IPv6 and keeps mixed notation intact', () => {
        expect(normalizeIp(' 2A01:CB00::1 ')).toBe('2a01:cb00::1');
        expect(normalizeIp('::ffff:abcd')).toBe('::ffff:abcd');
    });
});

describe('expandIpv6', () => {
    it('expands compressed and uppercase forms to 8 groups', () => {
        expect(expandIpv6('2A01:CB00:1:2::1')).toEqual(['2a01', 'cb00', '0001', '0002', '0000', '0000', '0000', '0001']);
        expect(expandIpv6('::1')).toEqual(['0000', '0000', '0000', '0000', '0000', '0000', '0000', '0001']);
    });

    it.each(['192.168.1.1', '1::2::3', '1:2:3', 'gggg::1', '1:2:3:4:5:6:7:8:9'])('rejects %s', (ip) => {
        expect(expandIpv6(ip)).toBeNull();
    });
});

describe('isSameIpv6Prefix64', () => {
    it('matches addresses of the same /64 whatever their notation', () => {
        expect(isSameIpv6Prefix64('2a01:cb00:1:2::abcd', '2A01:CB00:0001:0002:1111:2222:3333:4444')).toBe(true);
        expect(isSameIpv6Prefix64('2a01:cb00::1', '2a01:cb00:0:0:ffff::1')).toBe(true);
    });

    it('does not match another /64 or IPv4', () => {
        expect(isSameIpv6Prefix64('2a01:cb00:1:3::1', '2a01:cb00:1:2::1')).toBe(false);
        expect(isSameIpv6Prefix64('192.168.1.1', '2a01:cb00:1:2::1')).toBe(false);
    });
});

describe('safeCompare', () => {
    it('accepts identical secrets and rejects any other value, whatever its length', () => {
        expect(safeCompare('Bearer abc', 'Bearer abc')).toBe(true);
        expect(safeCompare('Bearer abd', 'Bearer abc')).toBe(false);
        expect(safeCompare('', 'Bearer abc')).toBe(false);
        expect(safeCompare('Bearer abc-and-more', 'Bearer abc')).toBe(false);
    });
});
