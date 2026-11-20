/**
 * HA Media Proxy Route
 * Proxies media from Home Assistant Media Source (e.g. PetKit historical snapshots).
 *
 * Usage: GET /api/ha/media?media_content_id=media-source://local/media/...
 */
import { withAuth } from '@/lib/api-middleware';
import { ApiResponse } from '@/lib/api-response';
import { haFetchBinary, haPost, type HABinaryResult } from '@/lib/haClient';
import { env, hasHAConfig } from '@/lib/env';
import { logger } from '@/lib/logger';
import { parseMediaContentId, resolveHaUrl } from '@/lib/ha-paths';

const FALLBACK_MEDIA_PLAYER = 'media_player.tv';

/** Item returned by media_player.browse_media (directly, or under service_response). */
interface BrowsedMedia {
    thumbnail?: string;
    media_content_id?: string;
}

type BrowseMediaResponse = BrowsedMedia & { service_response?: Record<string, BrowsedMedia> };

/**
 * Fetches a media file from Home Assistant.
 *
 * @param url - Absolute URL on the HA origin.
 * @param signal - Aborts the probe once another one succeeded.
 * @returns The image, or throws when HA has no such file.
 */
async function fetchMedia(url: string, signal?: AbortSignal): Promise<HABinaryResult> {
    const media = await haFetchBinary(url, { label: 'media', signal, expectMiss: true });
    if (!media.ok || !media.bytes) throw new Error(`${media.status}`);
    return media;
}

/**
 * GET /api/ha/media — returns a media-source image.
 *
 * @returns 200 with the image, 400 if the ID is outside the allowed providers, 502 if HA fails.
 */
export const GET = withAuth(async (request: Request) => {
    const mediaContentId = new URL(request.url).searchParams.get('media_content_id');
    if (!mediaContentId) {
        return ApiResponse.badRequest('Missing media_content_id');
    }

    const media = parseMediaContentId(mediaContentId);
    if (!media) {
        logger.security('Rejected media_content_id', { mediaContentId: mediaContentId.slice(0, 200) });
        return ApiResponse.badRequest('Invalid media_content_id');
    }

    if (!hasHAConfig()) {
        return ApiResponse.serverError('HA configuration missing');
    }

    try {
        const probePaths = [media.relativePath];
        if (media.relativePath.startsWith('media/')) {
            probePaths.push(media.relativePath.substring('media/'.length));
        }
        const providers = media.provider === 'local' ? ['local', 'local_source'] : [media.provider];

        const candidateUrls = providers.flatMap(provider =>
            probePaths.flatMap(path => [
                `${env.HA_BASE_URL}/api/media_source/${provider}/${path}`,
                `${env.HA_BASE_URL}/media/${provider}/${path}`,
            ]),
        );

        // The file lives under one of these paths: probe them together, stop the others on success
        const probes = new AbortController();
        let imageResponse: HABinaryResult | null = null;
        try {
            imageResponse = await Promise.any(candidateUrls.map(url => fetchMedia(url, probes.signal)));
            probes.abort();
        } catch {
            logger.warn('[HAMediaProxy] All direct paths failed, trying browse_media', { mediaContentId });
        }

        if (!imageResponse) {
            const resolveRes = await haPost<BrowseMediaResponse>(
                '/api/services/media_player/browse_media?return_response',
                { entity_id: FALLBACK_MEDIA_PLAYER, media_content_id: mediaContentId, media_content_type: 'image/jpeg' },
                'ha-media-resolve-fallback',
            );

            if (resolveRes.ok && resolveRes.data) {
                const result = resolveRes.data.service_response?.[FALLBACK_MEDIA_PLAYER] || resolveRes.data;
                const fallbackPath = result.thumbnail || result.media_content_id;

                if (fallbackPath && !fallbackPath.startsWith('media-source://')) {
                    // The HA token must never leave the HA origin, whatever browse_media returns
                    const fallbackUrl = resolveHaUrl(fallbackPath, env.HA_BASE_URL);
                    if (fallbackUrl) {
                        imageResponse = await fetchMedia(fallbackUrl).catch(() => null);
                    } else {
                        logger.security('[HAMediaProxy] Refused off-origin fallback URL', { mediaContentId });
                    }
                }
            }
        }

        if (!imageResponse) {
            logger.error('[HAMediaProxy] Media fetch failed', { mediaContentId });
            return ApiResponse.error('HA media fetch failed', 502);
        }

        // Authenticated content: browser cache only, never a shared cache
        return ApiResponse.image(imageResponse.bytes as Uint8Array<ArrayBuffer>, imageResponse.contentType, 'private, max-age=3600');
    } catch (error) {
        logger.error('[HAMediaProxy] Error', { mediaContentId, error: String(error) });
        return ApiResponse.serverError('Internal error during media proxying');
    }
});
