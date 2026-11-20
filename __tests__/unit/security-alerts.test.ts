import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const incr = vi.fn();
const expire = vi.fn();

vi.mock('@upstash/redis', () => ({
    Redis: vi.fn(function Redis() {
        return { incr, expire };
    }),
}));

type SecurityAlertsModule = typeof import('@/lib/security-alerts');

/** security-alerts is mocked globally and reads its config at import: load a fresh real copy. */
async function loadSecurityAlerts(env: Record<string, string> = {}): Promise<SecurityAlertsModule> {
    const config = {
        UPSTASH_REDIS_REST_URL: '',
        UPSTASH_REDIS_REST_TOKEN: '',
        ENABLE_UPSTASH_REDIS: '',
        SECURITY_SLACK_WEBHOOK: '',
        SECURITY_DISCORD_WEBHOOK: '',
        ...env,
    };
    for (const [key, value] of Object.entries(config)) vi.stubEnv(key, value);
    vi.resetModules();
    return vi.importActual<SecurityAlertsModule>('@/lib/security-alerts');
}

const event = { type: 'auth_failure' as const, ip: '203.0.113.9', path: '/api/x', userEmail: 'a@b.c', entityId: 'light.x', details: 'bad token' };

describe('trackSecurityEvent', () => {
    beforeEach(() => {
        incr.mockReset();
        expire.mockReset();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('alerts Slack and Discord exactly once, on the 5th attempt from the same IP (local counter)', async () => {
        const { trackSecurityEvent } = await loadSecurityAlerts({
            SECURITY_SLACK_WEBHOOK: 'https://hooks.slack.test/x',
            SECURITY_DISCORD_WEBHOOK: 'https://discord.test/x',
        });
        const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('ok'));

        for (let i = 0; i < 6; i++) await trackSecurityEvent(event);

        expect(fetchSpy).toHaveBeenCalledTimes(2);
        const urls = fetchSpy.mock.calls.map(([url]) => url);
        expect(urls).toEqual(['https://hooks.slack.test/x', 'https://discord.test/x']);
        const slackBody = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
        expect(slackBody.blocks[0].text.text).toContain('**Attempts:** 5 in 15 minutes');
        expect(slackBody.blocks[0].text.text).toContain('**Details:** bad token');
    });

    it('counts attempts per 15-minute window in the local fallback (P09)', async () => {
        vi.useFakeTimers({ now: new Date(Date.UTC(2026, 9, 22)) });
        const { trackSecurityEvent } = await loadSecurityAlerts({ SECURITY_SLACK_WEBHOOK: 'https://hooks.slack.test/x' });
        const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('ok'));

        for (let i = 0; i < 4; i++) await trackSecurityEvent(event);
        vi.advanceTimersByTime(15 * 60 * 1000);
        // A new window starts: four more attempts stay under the threshold
        for (let i = 0; i < 4; i++) await trackSecurityEvent(event);
        expect(fetchSpy).not.toHaveBeenCalled();

        await trackSecurityEvent(event);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        vi.useRealTimers();
    });

    it('sends nothing when no webhook is configured', async () => {
        const { trackSecurityEvent } = await loadSecurityAlerts();
        const fetchSpy = vi.spyOn(global, 'fetch');

        for (let i = 0; i < 5; i++) await trackSecurityEvent({ type: 'rate_limit', ip: '198.51.100.1' });

        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('never throws when a webhook call fails', async () => {
        const { trackSecurityEvent } = await loadSecurityAlerts({
            SECURITY_SLACK_WEBHOOK: 'https://hooks.slack.test/x',
            SECURITY_DISCORD_WEBHOOK: 'https://discord.test/x',
        });
        const fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(new Error('down'));

        for (let i = 0; i < 5; i++) await expect(trackSecurityEvent(event)).resolves.toBeUndefined();
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    describe('with Redis', () => {
        const REDIS_ENV = { UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 'token' };

        it('counts in Redis and sets the window TTL on the first attempt only', async () => {
            const { trackSecurityEvent } = await loadSecurityAlerts(REDIS_ENV);
            incr.mockResolvedValueOnce(1).mockResolvedValueOnce(2);

            await trackSecurityEvent(event);
            await trackSecurityEvent(event);

            expect(incr).toHaveBeenCalledWith('security:auth_failure:203.0.113.9');
            expect(expire).toHaveBeenCalledTimes(1);
            expect(expire).toHaveBeenCalledWith('security:auth_failure:203.0.113.9', 900);
        });

        it('swallows Redis errors', async () => {
            const { trackSecurityEvent } = await loadSecurityAlerts(REDIS_ENV);
            incr.mockRejectedValue(new Error('redis down'));

            await expect(trackSecurityEvent(event)).resolves.toBeUndefined();
        });
    });
});
