/**
 * Unit tests for lib/permissions.ts
 */
import { describe, it, expect } from 'vitest';
import {
    canAccessHistory,
    canAccessCameras,
    isOnHomeNetwork,
    canCallHAService,
    canProxyCamera,
    canSeeCameraEntities,
    canRenderHATemplate,
    canRunHAAction,
} from '@/lib/permissions';

describe('canAccessHistory', () => {
    it('admin → true', () => {
        expect(canAccessHistory({ group: 'admin' })).toBe(true);
    });

    it('user with explicit permission → true', () => {
        expect(canAccessHistory({ userGroup: { permissions: ['history'] } })).toBe(true);
    });

    it('user without permission → false', () => {
        expect(canAccessHistory({ group: 'user' })).toBe(false);
    });

    it('children → false', () => {
        expect(canAccessHistory({ group: 'children' })).toBe(false);
    });
});

describe('canAccessCameras', () => {
    it('admin → true', () => {
        expect(canAccessCameras({ group: 'admin' })).toBe(true);
    });

    it('user with cameras permission → true', () => {
        expect(canAccessCameras({ userGroup: { permissions: ['cameras'] } })).toBe(true);
    });

    it('user without cameras permission → false', () => {
        expect(canAccessCameras({ group: 'user' })).toBe(false);
    });

    it('children → false', () => {
        expect(canAccessCameras({ group: 'children' })).toBe(false);
    });
});

describe('isOnHomeNetwork', () => {
    it('null IP → false', async () => {
        expect(await isOnHomeNetwork(null)).toBe(false);
    });

    it('undefined IP → false', async () => {
        expect(await isOnHomeNetwork(undefined)).toBe(false);
    });

    it('localhost IPv4 → true', async () => {
        expect(await isOnHomeNetwork('127.0.0.1')).toBe(true);
    });

    it('localhost IPv6 → true', async () => {
        expect(await isOnHomeNetwork('::1')).toBe(true);
    });

    it('IPv4-mapped localhost → true', async () => {
        expect(await isOnHomeNetwork('::ffff:127.0.0.1')).toBe(true);
    });

    it('192.168.1.x → true', async () => {
        expect(await isOnHomeNetwork('192.168.1.42')).toBe(true);
    });

    it('192.168.0.x → true', async () => {
        expect(await isOnHomeNetwork('192.168.0.1')).toBe(true);
    });

    it('IPv4-mapped 192.168.1.x → true', async () => {
        expect(await isOnHomeNetwork('::ffff:192.168.1.100')).toBe(true);
    });

    it('external IP → false (no DNS match)', async () => {
        expect(await isOnHomeNetwork('8.8.8.8')).toBe(false);
    });
});

const groupUser = (group: string | undefined, permissions: string[] = []) => ({ group, userGroup: { permissions } });

describe('canCallHAService — current group rules', () => {
    it('refuses without a user and lets admins call anything', () => {
        expect(canCallHAService(null, 'light', 'light.x')).toBe(false);
        expect(canCallHAService(groupUser('admin'), 'alarm_control_panel', 'alarm_control_panel.maison')).toBe(true);
    });

    it('blocks children on sensitive domains and on sensitive entities called through another domain', () => {
        const child = groupUser('children');
        expect(canCallHAService(child, 'lock', 'lock.porte')).toBe(false);
        expect(canCallHAService(child, 'homeassistant', ['light.x', 'camera.salon'])).toBe(false);
        expect(canCallHAService(child, 'homeassistant', 'alarm_control_panel.maison')).toBe(false);
        expect(canCallHAService(child, 'script', 'script.coucher')).toBe(true);
    });

    it('lets the user group drive the alarm only with the alarm_control permission', () => {
        expect(canCallHAService(groupUser('user'), 'alarm_control_panel', 'alarm_control_panel.maison')).toBe(false);
        expect(canCallHAService(groupUser('user', ['alarm_control']), 'alarm_control_panel', 'alarm_control_panel.maison')).toBe(true);
        expect(canCallHAService(groupUser('user'), 'lock', 'lock.porte')).toBe(true);
    });

    it('treats a user without group as the user group', () => {
        expect(canCallHAService(groupUser(undefined), 'alarm_control_panel', 'alarm_control_panel.maison')).toBe(false);
    });
});

describe('canCallHAService — declared domain must match the target entity (M-1)', () => {
    it('blocks a user from reaching the alarm through a mismatched/generic domain', () => {
        const user = groupUser('user'); // no alarm_control permission
        // The bypass the audit flagged: declare a benign domain to touch the alarm entity.
        expect(canCallHAService(user, 'switch', 'alarm_control_panel.maison')).toBe(false);
        expect(canCallHAService(user, 'homeassistant', 'alarm_control_panel.maison')).toBe(false);
        expect(canCallHAService(user, 'light', ['light.salon', 'alarm_control_panel.maison'])).toBe(false);
    });

    it('keeps the alarm_control gate on the alarm domain intact', () => {
        // The domain-match guard makes domain === 'alarm_control_panel' the only way to reach it.
        expect(canCallHAService(groupUser('user', ['alarm_control']), 'alarm_control_panel', 'alarm_control_panel.maison')).toBe(true);
        expect(canCallHAService(groupUser('user'), 'alarm_control_panel', 'alarm_control_panel.maison')).toBe(false);
    });

    it('rejects any non-admin call whose domain does not match every entity', () => {
        expect(canCallHAService(groupUser('user'), 'switch', 'light.salon')).toBe(false);
        expect(canCallHAService(groupUser('children'), 'light', ['light.a', 'switch.b'])).toBe(false);
    });

    it('still allows the legitimate matching-domain calls the dashboard makes', () => {
        expect(canCallHAService(groupUser('user'), 'light', 'light.salon')).toBe(true);
        expect(canCallHAService(groupUser('user'), 'light', ['light.a', 'light.b'])).toBe(true);
        expect(canCallHAService(groupUser('user'), 'scene', 'scene.ambiance')).toBe(true);
        expect(canCallHAService(groupUser('user'), 'switch', 'switch.pc')).toBe(true);
        expect(canCallHAService(groupUser('user'), 'climate', 'climate.spa')).toBe(true);
        expect(canCallHAService(groupUser('children'), 'script', 'script.coucher')).toBe(true);
    });

    it('never restricts admins (generic domains and cross-domain batches stay allowed)', () => {
        expect(canCallHAService(groupUser('admin'), 'homeassistant', 'alarm_control_panel.maison')).toBe(true);
        expect(canCallHAService(groupUser('admin'), 'homeassistant', ['light.a', 'switch.b'])).toBe(true);
    });
});

describe('camera rules (F06, rights unchanged)', () => {
    it('hides camera entities from children only', () => {
        expect(canSeeCameraEntities(groupUser('children'))).toBe(false);
        expect(canSeeCameraEntities(groupUser('user'))).toBe(true);
        expect(canSeeCameraEntities(groupUser(undefined))).toBe(true);
        expect(canSeeCameraEntities(null)).toBe(true);
    });

    it('serves camera images to the cameras right, if the group itself grants cameras, * or the entity', () => {
        expect(canProxyCamera(groupUser('admin', ['cameras']), 'camera.x')).toBe(true);
        expect(canProxyCamera(groupUser('user', ['cameras']), 'camera.x')).toBe(true);
        expect(canProxyCamera(groupUser('admin', ['*']), 'camera.x')).toBe(true);
        expect(canProxyCamera(groupUser('admin', ['camera.x']), 'camera.x')).toBe(true);
        // An admin group stripped of `cameras` keeps the right but is refused the image
        expect(canProxyCamera(groupUser('admin', []), 'camera.x')).toBe(false);
        expect(canProxyCamera(groupUser('user', ['camera.x']), 'camera.x')).toBe(false);
        expect(canProxyCamera(null, 'camera.x')).toBe(false);
    });
});

describe('canRenderHATemplate (R1)', () => {
    it('allows the admin group only', () => {
        expect(canRenderHATemplate({ group: 'admin' })).toBe(true);
        expect(canRenderHATemplate({ group: 'user' })).toBe(false);
        expect(canRenderHATemplate({ group: 'children' })).toBe(false);
    });

    it('ignores permission flags and refuses a missing user or group', () => {
        expect(canRenderHATemplate({ group: 'user', userGroup: { permissions: ['*', 'admin'] } })).toBe(false);
        expect(canRenderHATemplate({})).toBe(false);
        expect(canRenderHATemplate(null)).toBe(false);
    });
});

describe('canRunHAAction (non-admins: the dashboard actions only)', () => {
    const user = groupUser('user');
    const child = groupUser('children');

    it('lets the admin group run any action', () => {
        expect(canRunHAAction(groupUser('admin'), 'script', 'turn_on', 'script.coucher')).toBe(true);
        expect(canRunHAAction(groupUser('admin'), 'lock', 'unlock', 'lock.porte')).toBe(true);
    });

    it.each([
        ['light', 'turn_on', 'light.salon'],
        ['light', 'turn_off', ['light.a', 'light.b']],
        ['switch', 'turn_off', 'switch.pc'],
        ['climate', 'set_temperature', 'climate.spa'],
        ['climate', 'set_hvac_mode', 'climate.salon'],
        ['select', 'select_option', 'select.spa_bulles'],
        ['button', 'press', 'button.lave_linge_depart'],
        ['scene', 'turn_on', 'scene.soiree'],
    ])('lets a family member run the dashboard action %s.%s', (domain, service, entityId) => {
        expect(canRunHAAction(user, domain, service, entityId)).toBe(true);
        expect(canRunHAAction(child, domain, service, entityId)).toBe(true);
    });

    it.each([
        ['script', 'turn_on', 'script.coucher'],
        ['automation', 'trigger', 'automation.desarmement'],
        ['lock', 'unlock', 'lock.porte'],
        ['cover', 'open_cover', 'cover.garage'],
        ['input_boolean', 'turn_on', 'input_boolean.mode_absent'],
        ['homeassistant', 'turn_on', 'light.salon'],
        ['light', 'toggle', 'light.salon'],
        ['scene', 'create', 'scene.nouvelle'],
        ['constructor', 'turn_on', 'constructor.x'],
    ])('refuses %s.%s to non-admins: the dashboard never offers it', (domain, service, entityId) => {
        expect(canRunHAAction(user, domain, service, entityId)).toBe(false);
        expect(canRunHAAction(groupUser('user', ['*', 'remote', 'alarm_control']), domain, service, entityId)).toBe(false);
    });

    it('keeps the alarm rules: alarm_control right for the user group, never for children', () => {
        expect(canRunHAAction(user, 'alarm_control_panel', 'alarm_disarm', 'alarm_control_panel.maison')).toBe(false);
        expect(canRunHAAction(groupUser('user', ['alarm_control']), 'alarm_control_panel', 'alarm_arm_night', 'alarm_control_panel.maison')).toBe(true);
        expect(canRunHAAction(groupUser('children', ['alarm_control']), 'alarm_control_panel', 'alarm_disarm', 'alarm_control_panel.maison')).toBe(false);
    });

    it('keeps the domain match: a dashboard service cannot reach another domain', () => {
        expect(canRunHAAction(user, 'switch', 'turn_off', 'alarm_control_panel.maison')).toBe(false);
        expect(canRunHAAction(user, 'light', 'turn_on', ['light.salon', 'lock.porte'])).toBe(false);
    });

    it('refuses a missing user', () => {
        expect(canRunHAAction(null, 'light', 'turn_on', 'light.salon')).toBe(false);
    });
});
