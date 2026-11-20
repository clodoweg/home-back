/**
 * Telegram Bot API client — thin wrapper around sendMessage.
 * Token is read from TELEGRAM_BOT_TOKEN env var.
 */
import { logger } from '@/lib/logger';

const TELEGRAM_API = 'https://api.telegram.org';

export async function sendTelegramMessage(chatId: string, text: string): Promise<boolean> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
        logger.warn('[Telegram] TELEGRAM_BOT_TOKEN not configured — skipping send');
        return false;
    }

    try {
        const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            }),
        });

        if (!response.ok) {
            const body = await response.text().catch(() => '');
            logger.error('[Telegram] sendMessage failed', {
                status: response.status,
                body: body.slice(0, 500),
            });
            return false;
        }
        return true;
    } catch (e) {
        logger.error('[Telegram] sendMessage error', { error: String(e) });
        return false;
    }
}

export interface TelegramPhoto {
    /** Image bytes (jpeg/png). */
    buffer: ArrayBuffer;
    /** Filename used in multipart (just for reference). */
    filename: string;
}

/**
 * Sends 1..10 photos as a Telegram album. Caption (HTML) is attached to the first photo.
 * Falls back to a single sendPhoto when only one photo is provided.
 */
export async function sendTelegramMediaGroup(
    chatId: string,
    photos: TelegramPhoto[],
    caption: string,
): Promise<boolean> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
        logger.warn('[Telegram] TELEGRAM_BOT_TOKEN not configured — skipping send');
        return false;
    }
    if (photos.length === 0) return false;

    try {
        const form = new FormData();
        form.append('chat_id', chatId);

        if (photos.length === 1) {
            const p = photos[0];
            form.append('photo', new Blob([p.buffer], { type: 'image/jpeg' }), p.filename);
            form.append('caption', caption);
            form.append('parse_mode', 'HTML');

            const response = await fetch(`${TELEGRAM_API}/bot${token}/sendPhoto`, {
                method: 'POST',
                body: form,
            });
            if (!response.ok) {
                const body = await response.text().catch(() => '');
                logger.error('[Telegram] sendPhoto failed', {
                    status: response.status,
                    body: body.slice(0, 500),
                });
                return false;
            }
            return true;
        }

        const media = photos.slice(0, 10).map((p, i) => ({
            type: 'photo' as const,
            media: `attach://photo${i}`,
            ...(i === 0 ? { caption, parse_mode: 'HTML' } : {}),
        }));
        form.append('media', JSON.stringify(media));
        photos.slice(0, 10).forEach((p, i) => {
            form.append(`photo${i}`, new Blob([p.buffer], { type: 'image/jpeg' }), p.filename);
        });

        const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMediaGroup`, {
            method: 'POST',
            body: form,
        });
        if (!response.ok) {
            const body = await response.text().catch(() => '');
            logger.error('[Telegram] sendMediaGroup failed', {
                status: response.status,
                body: body.slice(0, 500),
            });
            return false;
        }
        return true;
    } catch (e) {
        logger.error('[Telegram] sendMediaGroup error', { error: String(e) });
        return false;
    }
}
