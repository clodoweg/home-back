/**
 * POST /api/telegram/webhook — receives Update objects from Telegram and runs
 * registered commands on behalf of the sender.
 *
 * Security:
 *   - Telegram is told to include `secret_token` via setWebhook; we verify it
 *     against TELEGRAM_WEBHOOK_SECRET in the X-Telegram-Bot-Api-Secret-Token header.
 *   - The chat must belong to a User with group='admin' in our DB.
 *   - Unknown chats get a generic refusal (no info leak).
 *
 * Setup (one-time):
 *   curl -F url=https://home-back.psaltery.org/api/telegram/webhook \
 *        -F secret_token=<TELEGRAM_WEBHOOK_SECRET> \
 *        https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook
 */
import { ApiResponse } from '@/lib/api-response';
import prisma from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { safeCompare } from '@/lib/secure-compare';
import { haPost, haGet } from '@/lib/haClient';
import { dispatchCommand, sendTelegramMessage, sendTelegramMediaGroup } from '@/lib/integrations/telegram';
import { captureCameraPhotos } from '@/lib/integrations/arlo';

// /photo waits ~4 s for the Arlo capture before replying
export const maxDuration = 30;

interface TelegramUpdate {
    message?: {
        message_id: number;
        chat: { id: number };
        text?: string;
    };
}

export async function POST(request: Request) {
    const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!expected) {
        logger.error('[Telegram] TELEGRAM_WEBHOOK_SECRET not configured');
        return ApiResponse.serverError('Server misconfigured');
    }

    const provided = request.headers.get('x-telegram-bot-api-secret-token') ?? '';
    if (!safeCompare(provided, expected)) {
        logger.warn('[Telegram] webhook called with invalid secret');
        return ApiResponse.unauthorized();
    }

    let update: TelegramUpdate;
    try {
        update = (await request.json()) as TelegramUpdate;
    } catch {
        return ApiResponse.badRequest('Invalid JSON body');
    }

    const message = update.message;
    if (!message?.text || !message.chat?.id) {
        // Non-text events (edits, callbacks…) — acknowledge silently.
        return ApiResponse.success({ ok: true });
    }

    const chatId = String(message.chat.id);

    const user = await prisma.user.findFirst({
        where: { telegramChatId: chatId, group: 'admin' },
        select: { id: true },
    });
    if (!user) {
        logger.warn('[Telegram] webhook: unauthorized chat', { chatId });
        await sendTelegramMessage(chatId, '❌ Accès refusé');
        return ApiResponse.success({ ok: true });
    }

    try {
        await dispatchCommand(message.text, {
            chatId,
            sendMessage: sendTelegramMessage,
            sendPhotos: sendTelegramMediaGroup,
            captureCameras: captureCameraPhotos,
            callHaService: async (domain, service, entityId) => {
                const { ok } = await haPost(
                    `/api/services/${domain}/${service}`,
                    { entity_id: entityId },
                    `tg-cmd:${domain}.${service}`,
                );
                return ok;
            },
            getHaState: async (entityId) => {
                const { ok, data } = await haGet<{ state: string; attributes: Record<string, unknown> }>(
                    `/api/states/${entityId}`,
                    `tg-cmd:state:${entityId}`,
                );
                return ok && data ? { state: data.state, attributes: data.attributes || {} } : null;
            },
        });
    } catch (e) {
        logger.error('[Telegram] webhook dispatch error', { error: String(e) });
        await sendTelegramMessage(chatId, '❌ Erreur interne');
    }

    return ApiResponse.success({ ok: true });
}
