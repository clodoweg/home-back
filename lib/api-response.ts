/** API Response — réponses standardisées : JSON, erreurs `{ error, details, code }`, texte, images */
import { NextResponse } from 'next/server';

/**
 * API Response Utilities
 * Standardized helpers for success, error, text and image responses.
 */
export class ApiResponse {
    static success(data: unknown, status = 200) {
        return NextResponse.json(data, { status });
    }

    static error(message: string, status = 500, details?: unknown, code?: string) {
        return NextResponse.json(
            { error: message, details, code },
            { status }
        );
    }

    static badRequest(message = 'Bad Request', details?: unknown) {
        return this.error(message, 400, details);
    }

    static unauthorized(message = 'Unauthorized') {
        return this.error(message, 401);
    }

    static forbidden(message = 'Forbidden') {
        return this.error(message, 403);
    }

    static notFound(message = 'Not Found') {
        return this.error(message, 404);
    }

    static serverError(message = 'Internal Server Error', details?: unknown) {
        return this.error(message, 500, details);
    }

    /**
     * Plain-text response (rendered HA templates).
     *
     * @param body - Text to send.
     * @param status - HTTP status.
     * @returns The response.
     */
    static text(body: string, status = 200) {
        return new NextResponse(body, { status, headers: { 'Content-Type': 'text/plain' } });
    }

    /**
     * Image bytes. A non-image upstream content type is replaced by image/jpeg so that a
     * proxied HA response can never be served as HTML.
     *
     * @param bytes - Image content.
     * @param contentType - Upstream content type.
     * @param cacheControl - Cache-Control header (authenticated content must stay private).
     * @returns The response.
     */
    static image(bytes: Uint8Array<ArrayBuffer>, contentType: string | null, cacheControl: string) {
        return new NextResponse(bytes, {
            status: 200,
            headers: {
                'Content-Type': contentType?.startsWith('image/') ? contentType : 'image/jpeg',
                'Content-Length': bytes.byteLength.toString(),
                'Cache-Control': cacheControl,
            },
        });
    }
}
