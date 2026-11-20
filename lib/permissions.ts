/**
 * Permissions & Network Security Engine
 * Manages user feature access and detects home network proximity via IP/DDNS.
 * 
 * WARNING: This module is the source of truth for all access control. 
 * Any changes here can have critical security implications.
 */
import { isSameIpv6Prefix64, normalizeIp } from './client-ip';
import { logger } from '@/lib/logger';

/** What the permission rules read from a user (an AuthUser, or a partial one in tests). */
export interface PermissionSubject {
    group?: string | null;
    userGroup?: { permissions: string[] } | null;
}

type MaybeSubject = PermissionSubject | null | undefined;

/**
 * Core permission check: a user is granted a named permission if either
 * their group carries it explicitly, or they are in the 'admin' group.
 */
const hasPermission = (user: MaybeSubject, perm: string): boolean => {
    if (user?.userGroup?.permissions?.includes(perm)) return true;
    return (user?.group || 'user') === 'admin';
};

export const canAccessHistory = (user: MaybeSubject): boolean => hasPermission(user, 'history');
export const canAccessCameras = (user: MaybeSubject): boolean => hasPermission(user, 'cameras');

/**
 * Whether the user may render a free Jinja template on Home Assistant (POST /api/ha/template).
 * WARNING: the template runs with the HA admin token and can read every entity (camera access
 * tokens, people, locks) or load HA with an expensive loop: admin group only (audit R1). The
 * dashboard metadata goes through the fixed template of GET /api/ha/metadata instead.
 *
 * @param user - Authenticated user.
 * @returns true for the admin group only.
 */
export const canRenderHATemplate = (user: MaybeSubject): boolean => user?.group === 'admin';

/**
 * Whether the user gets the alerts in the front's bell and as Web Push notifications. Alerts
 * describe the whole house (alarm, cameras, consumption): admin group only, like Telegram.
 *
 * @param user - Authenticated user.
 * @returns true for the admin group only.
 */
export const canReceiveNotifications = (user: MaybeSubject): boolean => user?.group === 'admin';

/**
 * Whether camera entities may appear in the states list (they carry access tokens).
 *
 * @param user - Authenticated user.
 * @returns false for the children group only.
 */
export const canSeeCameraEntities = (user: MaybeSubject): boolean => (user?.group || 'user') !== 'children';

/**
 * Whether the user may read a camera image through the proxy. On top of the cameras right,
 * the user's group itself must hold `cameras`, `*` or the entity: an admin group stripped of
 * `cameras` is refused.
 *
 * @param user - Authenticated user.
 * @param entityId - Camera entity id.
 * @returns true when the image may be served.
 */
export const canProxyCamera = (user: MaybeSubject, entityId: string): boolean => {
    if (!canAccessCameras(user)) return false;
    const permissions = user?.userGroup?.permissions || [];
    return permissions.includes('*') || permissions.includes('cameras') || permissions.includes(entityId);
};

/**
 * Allowed home network origins: localhost, 127.0.0.1, ::1, 192.168.1.x, 192.168.0.x,
 * and the dynamic public IP resolved from the DDNS name in `HOME_DDNS_HOSTNAME`.
 * IPv6 is matched on the /64 prefix (first 4 segments).
 */
// ─── DNS Cache ────────────────────────────────────────────────────────────────

interface DnsCache {
    addresses: string[];
    fetchedAt: number;
}

let dnsCache: DnsCache | null = null;
const DNS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let hasWarnedMissingDdns = false;

/**
 * Resolves the DDNS hostname and caches the result for DNS_CACHE_TTL ms.
 * Avoids 2 DNS round-trips (resolve4 + resolve6) on every API request.
 * The hostname is configuration, not code: it reveals the home's public IP, and the repository
 * may be public. Without it, no public IP counts as the home network (fails closed).
 */
async function resolveDdnsAddresses(): Promise<string[]> {
    const ddnsHostname = (process.env.HOME_DDNS_HOSTNAME || '').trim();
    if (!ddnsHostname) {
        if (!hasWarnedMissingDdns) {
            hasWarnedMissingDdns = true;
            logger.warn('HOME_DDNS_HOSTNAME is empty: only LAN addresses count as the home network');
        }
        return [];
    }
    if (dnsCache && Date.now() - dnsCache.fetchedAt < DNS_CACHE_TTL) {
        return dnsCache.addresses;
    }

    const dns = await import('dns');
    const [ipv4, ipv6] = await Promise.all([
        dns.promises.resolve4(ddnsHostname).catch(() => [] as string[]),
        dns.promises.resolve6(ddnsHostname).catch(() => [] as string[]),
    ]);

    const addresses = [...ipv4, ...ipv6];
    dnsCache = { addresses, fetchedAt: Date.now() };
    return addresses;
}

/**
 * Detects if an IP address belongs to the home network environment.
 * Matches local subnets (192.168.x.x) or the resolved IP from DDNS.
 * 
 * @param ip - The incoming request IP address.
 * @returns true if the IP is originating from the home network.
 */
export const isOnHomeNetwork = async (ip?: string | null): Promise<boolean> => {
    if (!ip) return false;

    const cleanIp = normalizeIp(ip);

    // Localhost
    if (cleanIp === '127.0.0.1' || cleanIp === '::1') return true;

    // Home Subnets (192.168.1.x and 192.168.0.x)
    if (cleanIp.startsWith('192.168.1.') || cleanIp.startsWith('192.168.0.')) return true;

    // Dynamic DNS Check — uses cached resolution
    try {
        const addresses = await resolveDdnsAddresses();

        return addresses.some(address => {
            const cleanAddress = normalizeIp(address);
            if (cleanIp === cleanAddress) return true;
            // The ISP delegates a /64 to the home: any address of that prefix is at home
            return isSameIpv6Prefix64(cleanIp, cleanAddress);
        });
    } catch (e) {
        logger.error('Failed to resolve Home IP via DNS', { error: String(e) });
    }

    return false;
};

/**
 * Sensitive HA domains restricted to admin/user groups.
 * children cannot control these regardless of entity_id.
 */
const SENSITIVE_DOMAINS = new Set(['alarm_control_panel', 'lock', 'camera']);

/**
 * HA domain of an entity_id: the part before the first dot (`light.salon` → `light`).
 * An id with no dot yields the whole string, which matches no real domain.
 *
 * @param entityId - A Home Assistant entity_id.
 * @returns Its domain prefix.
 */
const entityDomainOf = (entityId: string): string => entityId.split('.')[0];

/**
 * Checks if a user can call a given HA service on a given entity.
 *
 * WARNING: for non-admins the declared `domain` must match the real domain of every target
 * entity. Permissions below (alarm, sensitive domains) key on `domain`, so without this guard a
 * benign/generic domain (`switch.turn_off`, `homeassistant.turn_off`) could reach a sensitive
 * entity (e.g. the alarm) and skip the check — audit M-1. `scene`/`script` stay allowed (the
 * dashboard uses them): a scene or script that itself touches the alarm is a HA-config concern.
 *
 * @param user - The User object with group info.
 * @param domain - HA domain (e.g. 'switch', 'alarm_control_panel').
 * @param entityId - Target HA entity_id (array or string).
 * @returns true if call is allowed.
 */
export function canCallHAService(user: MaybeSubject, domain: string, entityId: string | string[]): boolean {
    if (!user) return false;
    const group = user?.group || 'user';
    if (group === 'admin') return true;

    const entities = Array.isArray(entityId) ? entityId : [entityId];

    // Non-admins may only hit entities whose own domain matches the declared service domain:
    // the authorization below trusts `domain` to describe what is actually targeted.
    if (!entities.every(e => entityDomainOf(e) === domain)) return false;

    // children: block every sensitive domain outright. The domain-match guard above means the
    // targeted entities share that domain, so blocking the domain blocks the sensitive entities
    // (no need to also test entity prefixes: a sensitive entity can only arrive via its own domain).
    if (group === 'children' && SENSITIVE_DOMAINS.has(domain)) return false;

    // user group: block the alarm unless the explicit permission is granted. The domain-match
    // guard above guarantees `domain === 'alarm_control_panel'` exactly when an alarm entity is
    // targeted, so no generic domain can slip an alarm action past this check.
    if (group === 'user' && domain === 'alarm_control_panel') {
        const permissions = user?.userGroup?.permissions || [];
        return permissions.includes('alarm_control');
    }

    return true;
}
