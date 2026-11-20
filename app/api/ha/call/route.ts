import { withAuth } from '@/lib/api-middleware';
import { ApiResponse } from '@/lib/api-response';
import { haPost } from '@/lib/haClient';
import { callSchema, stripTargetOverrides, validateBody } from '@/lib/validators';
import { canCallHAService } from '@/lib/permissions';
import { logger } from '@/lib/logger';

export const POST = withAuth(async (request, { user, userEmail }) => {
    // Validate request body with Zod
    const validation = await validateBody(request, callSchema);
    if (!validation.success) {
        return validation.error;
    }

    const { domain, service, entity_id, service_data, return_response } = validation.data;

    // Group-based authorization on the target domain + entity
    if (!canCallHAService(user, domain, entity_id)) {
        logger.security('Blocked HA service call', { userEmail, domain, service, entity_id: String(entity_id) });
        return ApiResponse.forbidden('Forbidden: You do not have permission for this entity');
    }

    // entity_id goes last and targeting keys are stripped: the call must hit only the
    // entities checked by canCallHAService above
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
