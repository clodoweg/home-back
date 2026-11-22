import { S3Client, PutObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { NextResponse } from 'next/server';
import { ApiResponse } from './api-response';
import { logger } from '@/lib/logger';

const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL_CONFIG = process.env.R2_PUBLIC_URL;
const R2_PUBLIC_URL = R2_PUBLIC_URL_CONFIG || R2_ENDPOINT;

const R2_PRIVATE_HOST_SUFFIX = 'cloudflarestorage.com';

/**
 * Whether R2_PUBLIC_URL can be opened by a browser without a signature. The S3 endpoint
 * (`<account>.r2.cloudflarestorage.com`) is private; the check reads the URL's host rather than
 * searching the whole string. An invalid URL counts as private: `proxyImageViaR2` then serves the
 * bytes instead of redirecting to a broken address.
 *
 * @returns True when R2_PUBLIC_URL is a valid URL whose host is not the private R2 endpoint.
 */
export function isR2Public(): boolean {
    const publicUrl = process.env.R2_PUBLIC_URL;
    if (!publicUrl || !URL.canParse(publicUrl)) return false;
    const { hostname } = new URL(publicUrl);
    const isPrivateEndpoint =
        hostname === R2_PRIVATE_HOST_SUFFIX || hostname.endsWith(`.${R2_PRIVATE_HOST_SUFFIX}`);
    return !isPrivateEndpoint;
}

const isConfigured = Boolean(R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_ENDPOINT && R2_BUCKET_NAME);

if (!isConfigured && process.env.NODE_ENV === 'production') {
    logger.warn('[R2] Configuration check failed', {
        hasAccessKeyId: !!R2_ACCESS_KEY_ID,
        hasSecretAccessKey: !!R2_SECRET_ACCESS_KEY,
        hasEndpoint: !!R2_ENDPOINT,
        hasBucketName: !!R2_BUCKET_NAME
    });
}

const s3Client = isConfigured
    ? new S3Client({
        region: 'auto',
        endpoint: R2_ENDPOINT,
        credentials: {
            accessKeyId: R2_ACCESS_KEY_ID!,
            secretAccessKey: R2_SECRET_ACCESS_KEY!,
        },
    })
    : null;

/**
 * Upload a buffer to Cloudflare R2.
 * 
 * @param buffer - The image buffer.
 * @param key - The destination key (filename) in the bucket.
 * @param contentType - The MIME type of the file.
 * @returns The public URL of the uploaded file.
 */
export async function uploadToR2(buffer: Buffer, key: string, contentType: string = 'image/jpeg'): Promise<string | null> {
    if (!s3Client || !R2_BUCKET_NAME) {
        logger.warn('[R2] Storage not configured, skipping upload.');
        return null;
    }

    try {
        await s3Client.send(
            new PutObjectCommand({
                Bucket: R2_BUCKET_NAME,
                Key: key,
                Body: buffer,
                ContentType: contentType,
            })
        );

        // Return the final URL
        // If the public URL ends with a slash, don't add another one
        const baseUrl = R2_PUBLIC_URL!.endsWith('/') ? R2_PUBLIC_URL!.slice(0, -1) : R2_PUBLIC_URL;
        return `${baseUrl}/${key}`;
    } catch (error) {
        logger.error(`[R2] Failed to upload ${key}`, { error: String(error) });
        return null;
    }
}

/**
 * Delete objects with a specific prefix that are older than N days.
 * 
 * @param prefix - The directory prefix (e.g., 'cameras/').
 * @param days - Number of days to keep.
 */
export async function deleteOldObjects(prefix: string, days: number): Promise<{ deleted: number; errors: number }> {
    if (!s3Client || !R2_BUCKET_NAME) return { deleted: 0, errors: 0 };

    const threshold = new Date();
    threshold.setDate(threshold.getDate() - days);

    let deletedCount = 0;
    let errorCount = 0;

    try {
        const listCommand = new ListObjectsV2Command({
            Bucket: R2_BUCKET_NAME,
            Prefix: prefix,
        });

        const listResponse = await s3Client.send(listCommand);
        const contents = listResponse.Contents || [];

        const objectsToDelete = contents.filter(obj => {
            return obj.LastModified && obj.LastModified < threshold;
        });

        if (objectsToDelete.length === 0) {
            return { deleted: 0, errors: 0 };
        }

        // S3 DeleteObjects supports batching up to 1000
        const batchSize = 1000;
        for (let i = 0; i < objectsToDelete.length; i += batchSize) {
            const batch = objectsToDelete.slice(i, i + batchSize);
            const keys = batch.map(obj => ({ Key: obj.Key! }));

            try {
                const deleteCommand = new DeleteObjectsCommand({
                    Bucket: R2_BUCKET_NAME,
                    Delete: {
                        Objects: keys,
                        Quiet: true,
                    },
                });

                await s3Client.send(deleteCommand);
                deletedCount += batch.length;
            } catch (err) {
                logger.error(`[R2] Failed to delete batch starting at index ${i}`, { error: String(err) });
                errorCount += batch.length;
            }
        }

        return { deleted: deletedCount, errors: errorCount };

    } catch (error) {
        logger.error(`[R2] Error during cleanup`, { error: String(error) });
        return { deleted: deletedCount, errors: errorCount };
    }
}

export function isR2Configured(): boolean {
    return !!isConfigured;
}

/**
 * Proxy an image via R2: if the bucket is configured and public, upload
 * the buffer and return a 302 redirect to the public URL, saving Vercel bandwidth.
 * Otherwise serve the bytes directly: uploading to a private bucket that nothing
 * reads back would only cost a write per request.
 *
 * @param buffer - Image bytes.
 * @param key - R2 object key.
 * @param contentType - MIME type.
 * @param cacheControl - Cache-Control header when serving directly (authenticated content: private by default).
 * @returns NextResponse (redirect or body).
 */
export async function proxyImageViaR2(
    buffer: Buffer,
    key: string,
    contentType: string = 'image/jpeg',
    cacheControl: string = 'private, no-store'
): Promise<NextResponse> {
    if (isR2Configured() && isR2Public()) {
        try {
            const url = await uploadToR2(buffer, key, contentType);
            if (url) {
                return NextResponse.redirect(url, { status: 302 });
            }
        } catch (error) {
            logger.error(`[R2] proxyImageViaR2 upload failed for ${key}`, { error: String(error) });
        }
    }

    return ApiResponse.image(new Uint8Array(buffer), contentType, cacheControl);
}
