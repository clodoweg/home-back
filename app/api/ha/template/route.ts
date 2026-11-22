/** HA template — free Jinja rendering on Home Assistant, reserved to the admin group */
import { ApiResponse } from '@/lib/api-response';
import { withAuth } from '@/lib/api-middleware';
import { logger } from '@/lib/logger';
import { haPost } from '@/lib/haClient';
import { canRenderHATemplate } from '@/lib/permissions';
import { templateSchema, validateBody } from '@/lib/validators';
import * as crypto from 'crypto';

// ─── Template Cache ──────────────────────────────────────────────────────────
// In-memory cache keyed by MD5 hash of the template string. TTL: 5 minutes.
// Bounded: a warm instance must not keep every template ever rendered.
const templateCache = new Map<string, { data: string; fetchedAt: number }>();
const TEMPLATE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const TEMPLATE_CACHE_MAX_ENTRIES = 200;

/**
 * Stores a rendered template, dropping expired entries and, when still full, the oldest one
 * (a Map iterates in insertion order).
 */
function cacheTemplate(hash: string, data: string): void {
    const now = Date.now();
    for (const [key, entry] of templateCache) {
        if (now - entry.fetchedAt >= TEMPLATE_CACHE_TTL) templateCache.delete(key);
    }
    if (templateCache.size >= TEMPLATE_CACHE_MAX_ENTRIES) {
        templateCache.delete(templateCache.keys().next().value as string);
    }
    templateCache.set(hash, { data, fetchedAt: now });
}

function getTemplateHash(template: string): string {
    return crypto.createHash('sha256').update(template).digest('hex');
}


/**
 * POST /api/ha/template — renders a free Jinja template on HA (admin group only, audit R1).
 *
 * @returns 200 with the rendered text, 400 on an invalid body, 403 outside the admin group,
 * 502 when HA fails.
 */
export const POST = withAuth(async (request, { user, userEmail }) => {
    const validation = await validateBody(request, templateSchema);
    if (!validation.success) {
        return validation.error;
    }

    const { template } = validation.data;

    if (!canRenderHATemplate(user)) {
        // Only the size is logged: the template itself may embed sensitive values
        logger.security('Blocked HA template', { userEmail, group: user.group, templateLength: template.length });
        return ApiResponse.forbidden('Forbidden: templates are restricted to administrators');
    }

    const templateHash = getTemplateHash(template);
    const cached = templateCache.get(templateHash);

    if (cached && Date.now() - cached.fetchedAt < TEMPLATE_CACHE_TTL) {
        return ApiResponse.text(cached.data);
    }

    const { data, ok } = await haPost<string>(
        '/api/template',
        { template },
        'template'
    );

    if (!ok) {
        return ApiResponse.error('Failed to execute template on Home Assistant', 502);
    }

    cacheTemplate(templateHash, data);

    return ApiResponse.text(data);
});
