import { withAuth } from '@/lib/api-middleware';
import { ApiResponse } from '@/lib/api-response';
import { haPost } from '@/lib/haClient';
import { callSchema, stripTargetOverrides, validateBody } from '@/lib/validators';
import { canRunHAAction } from '@/lib/permissions';
import { logger } from '@/lib/logger';

/**
 * POST /api/ha/call — runs a Home Assistant action: any for the admin group, only the dashboard's
 * actions for the other groups (`canRunHAAction`).
 *
 * @returns 200 with the HA answer, 400 on an invalid body, 403 when the action is not allowed to
 * the caller's group, 502 when HA fails.
 */
export const POST = withAuth(async (request, { user, userEmail }) => {
    // Validate request body with Zod
    const validation = await validateBody(request, callSchema);
    if (!validation.success) {
        return validation.error;
    }

    const { domain, service, entity_id, service_data, return_response } = validation.data;

    if (!canRunHAAction(user, domain, service, entity_id)) {
        logger.security('Blocked HA service call', { userEmail, domain, service, entity_id: String(entity_id) });
        return ApiResponse.forbidden('Forbidden: You do not have permission for this entity');
    }

    // entity_id goes last and targeting keys are stripped: the call hits only the entities
    // named in entity_id, never an area, device or label a client slips into service_data
    const payload = {
        ...stripTargetOverrides(service_data),
        entity_id,
    };

    const endpoint = `/api/services/${domain}/${service}${return_response ? '?return_response=true' : ''}`;

    const { data, ok } = await haPost(
        endpoint,
        payload,
        `call:${domain}.${service}`
    );

    if (!ok) {
        return ApiResponse.error('Failed to execute action on Home Assistant', 502);
    }

    return ApiResponse.success(data);
});
