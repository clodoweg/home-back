import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const send = vi.fn();

vi.mock('@aws-sdk/client-s3', () => {
    const command = (name: string) =>
        class {
            constructor(public input: Record<string, unknown>) {}
            readonly commandName = name;
        };
    return {
        S3Client: vi.fn(function S3Client() {
            return { send };
        }),
        PutObjectCommand: command('Put'),
        CopyObjectCommand: command('Copy'),
        DeleteObjectCommand: command('Delete'),
        DeleteObjectsCommand: command('DeleteObjects'),
        ListObjectsV2Command: command('List'),
        GetObjectCommand: command('Get'),
    };
});

const R2_ENV = {
    R2_ACCESS_KEY_ID: 'key',
    R2_SECRET_ACCESS_KEY: 'secret',
    R2_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
    R2_BUCKET_NAME: 'bucket',
};

/** r2.ts reads its configuration at import time: load a fresh copy per scenario. */
async function loadR2(env: Record<string, string> = R2_ENV) {
    const config = { ...R2_ENV, R2_PUBLIC_URL: '', ...env };
    for (const [key, value] of Object.entries(config)) vi.stubEnv(key, value);
    vi.resetModules();
    return import('@/lib/r2');
}

describe('r2', () => {
    beforeEach(() => {
        send.mockReset();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    describe('without configuration', () => {
        it('is not configured and skips uploads and cleanups', async () => {
            const r2 = await loadR2({ R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '', R2_ENDPOINT: '', R2_BUCKET_NAME: '' });

            expect(r2.isR2Configured()).toBe(false);
            expect(await r2.uploadToR2(Buffer.from('x'), 'k.jpg')).toBeNull();
            expect(await r2.deleteOldObjects('cameras/', 7)).toEqual({ deleted: 0, errors: 0 });
            expect(send).not.toHaveBeenCalled();
        });

        it('serves the buffer itself as private content', async () => {
            const r2 = await loadR2({ R2_ACCESS_KEY_ID: '' });

            const res = await r2.proxyImageViaR2(Buffer.from('img'), 'k.jpg');

            expect(res.status).toBe(200);
            expect(res.headers.get('cache-control')).toBe('private, no-store');
            expect(res.headers.get('content-type')).toBe('image/jpeg');
        });
    });

    describe('isR2Public', () => {
        it('is false for the private cloudflarestorage endpoint and true for a custom domain', async () => {
            const r2 = await loadR2();
            expect(r2.isR2Public()).toBe(false);

            vi.stubEnv('R2_PUBLIC_URL', 'https://account.r2.cloudflarestorage.com/bucket');
            expect(r2.isR2Public()).toBe(false);

            vi.stubEnv('R2_PUBLIC_URL', 'https://media.example.org');
            expect(r2.isR2Public()).toBe(true);
        });
    });

    describe('uploadToR2', () => {
        it('puts the object and returns its URL without a double slash', async () => {
            const r2 = await loadR2({ ...R2_ENV, R2_PUBLIC_URL: 'https://media.example.org/' });
            send.mockResolvedValue({});

            const url = await r2.uploadToR2(Buffer.from('x'), 'cameras/a.jpg', 'image/png');

            expect(url).toBe('https://media.example.org/cameras/a.jpg');
            expect(send.mock.calls[0][0].input).toMatchObject({ Bucket: 'bucket', Key: 'cameras/a.jpg', ContentType: 'image/png' });
        });

        it('returns null when the upload fails', async () => {
            const r2 = await loadR2();
            send.mockRejectedValue(new Error('network'));

            expect(await r2.uploadToR2(Buffer.from('x'), 'a.jpg')).toBeNull();
        });
    });

    describe('proxyImageViaR2', () => {
        it('redirects to the public URL when the bucket is public', async () => {
            const r2 = await loadR2({ ...R2_ENV, R2_PUBLIC_URL: 'https://media.example.org' });
            send.mockResolvedValue({});

            const res = await r2.proxyImageViaR2(Buffer.from('img'), 'cameras/a.jpg');

            expect(res.status).toBe(302);
            expect(res.headers.get('location')).toBe('https://media.example.org/cameras/a.jpg');
        });

        it('serves the buffer without any upload when the bucket is private (P04)', async () => {
            const r2 = await loadR2();
            send.mockResolvedValue({});

            const res = await r2.proxyImageViaR2(Buffer.from('img'), 'cameras/a.jpg', 'image/png', 'private, max-age=60');

            expect(send).not.toHaveBeenCalled();
            expect(res.status).toBe(200);
            expect(res.headers.get('cache-control')).toBe('private, max-age=60');
        });
    });

    describe('deleteOldObjects', () => {
        const old = new Date(Date.now() - 10 * 24 * 3600 * 1000);
        const recent = new Date();

        it('deletes only objects older than the retention', async () => {
            const r2 = await loadR2();
            send
                .mockResolvedValueOnce({ Contents: [{ Key: 'cameras/old.jpg', LastModified: old }, { Key: 'cameras/new.jpg', LastModified: recent }] })
                .mockResolvedValueOnce({});

            const result = await r2.deleteOldObjects('cameras/', 7);

            expect(result).toEqual({ deleted: 1, errors: 0 });
            expect(send.mock.calls[1][0].input).toMatchObject({ Delete: { Objects: [{ Key: 'cameras/old.jpg' }] } });
        });

        it('does nothing when no object is old enough', async () => {
            const r2 = await loadR2();
            send.mockResolvedValueOnce({ Contents: [{ Key: 'a', LastModified: recent }] });

            expect(await r2.deleteOldObjects('cameras/', 7)).toEqual({ deleted: 0, errors: 0 });
            expect(send).toHaveBeenCalledTimes(1);
        });

        it('counts a failed batch as errors', async () => {
            const r2 = await loadR2();
            send.mockResolvedValueOnce({ Contents: [{ Key: 'a', LastModified: old }] }).mockRejectedValueOnce(new Error('denied'));

            expect(await r2.deleteOldObjects('cameras/', 7)).toEqual({ deleted: 0, errors: 1 });
        });

        it('survives a listing failure', async () => {
            const r2 = await loadR2();
            send.mockRejectedValueOnce(new Error('list failed'));

            expect(await r2.deleteOldObjects('cameras/', 7)).toEqual({ deleted: 0, errors: 0 });
        });
    });
});
