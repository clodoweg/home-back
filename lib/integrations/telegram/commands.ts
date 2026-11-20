/**
 * Telegram bot command dispatcher.
 *
 * Maps incoming `/<command> <args>` messages to handlers that call HA services
 * and reply on the same chat. The dispatcher is pure logic — fetching states,
 * triggering snapshots, and sending messages are injected so it can be unit-tested
 * without network or env dependencies.
 */
import type { TelegramPhoto } from './client';
import { escapeHtml } from './format';

export interface CommandContext {
    chatId: string;
    args: string[];
    /** Calls a HA service. Returns true on success. */
    callHaService: (domain: string, service: string, entityId: string) => Promise<boolean>;
    /** Returns the current state object for an entity, or null. */
    getHaState: (entityId: string) => Promise<{ state: string; attributes: Record<string, unknown> } | null>;
    /** Triggers Arlo snapshots and returns fresh JPEG bytes per camera. */
    captureCameras: (cameraEntityIds: string[]) => Promise<TelegramPhoto[]>;
    /** Sends an HTML-formatted reply. */
    sendMessage: (chatId: string, text: string) => Promise<boolean>;
    /** Sends 1..10 photos with an HTML caption on the first one. */
    sendPhotos: (chatId: string, photos: TelegramPhoto[], caption: string) => Promise<boolean>;
}

export interface CommandHandler {
    name: string;
    description: string;
    handle: (ctx: CommandContext) => Promise<void>;
}

const ALARM_ENTITY = 'alarm_control_panel.somfy_home_alarm_maison';
const CAMERAS = ['camera.aarlo_salon', 'camera.aarlo_entree'];

const armCommand =
    (service: 'alarm_arm_away' | 'alarm_arm_home' | 'alarm_arm_night' | 'alarm_disarm', label: string) =>
    async (ctx: CommandContext): Promise<void> => {
        const ok = await ctx.callHaService('alarm_control_panel', service, ALARM_ENTITY);
        await ctx.sendMessage(
            ctx.chatId,
            ok ? `🛡️ Alarme ${label}` : `❌ Échec : alarme ${label}`,
        );
    };

export const commands: Record<string, CommandHandler> = {
    status: {
        name: '/status',
        description: 'État de l’alarme et résumé',
        handle: async (ctx) => {
            const alarm = await ctx.getHaState(ALARM_ENTITY);
            if (!alarm) {
                await ctx.sendMessage(ctx.chatId, '❌ Impossible de lire l’état de l’alarme');
                return;
            }
            const stateLabel: Record<string, string> = {
                disarmed: 'désactivée',
                armed_away: 'activée (absent)',
                armed_home: 'activée (maison)',
                armed_night: 'activée (nuit)',
                triggered: 'déclenchée',
                arming: 'en cours d’activation',
                disarming: 'en cours de désactivation',
            };
            await ctx.sendMessage(
                ctx.chatId,
                `🛡️ Alarme : <b>${stateLabel[alarm.state] || escapeHtml(alarm.state)}</b>`,
            );
        },
    },
    photo: {
        name: '/photo',
        description: 'Capture les caméras et renvoie les photos',
        handle: async (ctx) => {
            await ctx.sendMessage(ctx.chatId, '📸 Capture en cours…');
            const photos = await ctx.captureCameras(CAMERAS);
            if (photos.length === 0) {
                await ctx.sendMessage(ctx.chatId, '❌ Aucune photo récupérée');
                return;
            }
            await ctx.sendPhotos(ctx.chatId, photos, '📸 Caméras');
        },
    },
    arm: {
        name: '/arm',
        description: 'Active l’alarme (mode absent)',
        handle: armCommand('alarm_arm_away', 'activée (absent)'),
    },
    arm_home: {
        name: '/arm_home',
        description: 'Active l’alarme (mode maison)',
        handle: armCommand('alarm_arm_home', 'activée (maison)'),
    },
    arm_night: {
        name: '/arm_night',
        description: 'Active l’alarme (mode nuit)',
        handle: armCommand('alarm_arm_night', 'activée (nuit)'),
    },
    disarm: {
        name: '/disarm',
        description: 'Désactive l’alarme',
        handle: armCommand('alarm_disarm', 'désactivée'),
    },
    help: {
        name: '/help',
        description: 'Affiche cette aide',
        handle: async (ctx) => {
            const lines = Object.values(commands).map((c) => `${c.name} — ${c.description}`);
            await ctx.sendMessage(
                ctx.chatId,
                `<b>Commandes disponibles</b>\n${lines.join('\n')}`,
            );
        },
    },
};

/**
 * Parses a raw Telegram message text into a command + args.
 * Returns null if the text is not a `/command`.
 *
 * Supports the `/command@BotName` form (Telegram appends @BotName in groups).
 */
export function parseCommand(text: string): { command: string; args: string[] } | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) return null;
    const parts = trimmed.slice(1).split(/\s+/);
    const head = parts[0];
    if (!head) return null;
    const [command] = head.split('@');
    return { command: command.toLowerCase(), args: parts.slice(1) };
}

export async function dispatchCommand(text: string, ctx: Omit<CommandContext, 'args'>): Promise<boolean> {
    const parsed = parseCommand(text);
    if (!parsed) return false;
    const handler = commands[parsed.command];
    if (!handler) {
        await ctx.sendMessage(
            ctx.chatId,
            `❓ Commande inconnue : /${escapeHtml(parsed.command)}\nTape /help pour la liste.`,
        );
        return false;
    }
    await handler.handle({ ...ctx, args: parsed.args });
    return true;
}
