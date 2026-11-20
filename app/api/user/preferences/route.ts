import { withAuth } from "@/lib/api-middleware";
import { ApiResponse } from "@/lib/api-response";
import prisma, { CONNECTION_TIMEOUT_MS } from "@/lib/prisma";
import type { Prisma } from '@/lib/generated/prisma/client';
import { invalidateUserCache } from "@/lib/user-cache";
import { widgetPreferencesSchema, validateBody } from "@/lib/validators";
import { logger } from "@/lib/logger";

export const GET = withAuth(async (_request, { user }) => {
  return ApiResponse.success({
    preferences: user.widgetPreferences || {},
    telegramChatId: user.telegramChatId || null,
    notificationPreferences: user.notificationPreferences || {},
  });
});

export const POST = withAuth(async (request, { user }) => {
  const validation = await validateBody(request, widgetPreferencesSchema);
  if (!validation.success) return validation.error;

  const {
    widgetOrder,
    roomOrder,
    floorOrder,
    roomIcons,
    hiddenWidgets,
    hiddenRooms,
    hiddenSensors,
    collapsed,
    tempThresholds,
    humThresholds,
    theme,
    telegramChatId,
    notificationPreferences,
    notificationSpaTempThreshold,
    notificationHumidityThreshold,
    notificationTempMinThreshold,
    notificationTempMaxThreshold,
    notificationHumidityMinThreshold,
    notificationHumidityMaxThreshold,
  } = validation.data;

  try {
    // WARNING: merge on the row read under a lock, never on the cached `user`: the cache lives
    // 5 min per server instance, so an earlier save served by another instance (or a concurrent
    // one) would be overwritten by the stale copy. Prisma's default maxWait (2 s) includes taking
    // a pool connection: a slow database gets the same 10 s as any other query.
    const data = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`;
      const current = await tx.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { widgetPreferences: true, notificationPreferences: true },
      });

      const update: Prisma.UserUpdateInput = {};
      if (theme) update.theme = theme;
      if (telegramChatId !== undefined) update.telegramChatId = telegramChatId;
      if (notificationPreferences !== undefined) {
        const existing =
          (current.notificationPreferences as Record<string, boolean>) || {};
        update.notificationPreferences = { ...existing, ...notificationPreferences };
      }

      const existingPrefs = (current.widgetPreferences as Record<string, unknown>) || {};
      const nextPrefs = { ...existingPrefs };
      if (widgetOrder !== undefined) nextPrefs.widgetOrder = widgetOrder;
      if (roomOrder !== undefined) nextPrefs.roomOrder = roomOrder;
      if (floorOrder !== undefined) nextPrefs.floorOrder = floorOrder;
      if (roomIcons !== undefined) nextPrefs.roomIcons = roomIcons;
      if (hiddenWidgets !== undefined) nextPrefs.hiddenWidgets = hiddenWidgets;
      if (hiddenRooms !== undefined) nextPrefs.hiddenRooms = hiddenRooms;
      if (hiddenSensors !== undefined) nextPrefs.hiddenSensors = hiddenSensors;
      if (collapsed !== undefined) nextPrefs.collapsed = collapsed;
      if (tempThresholds !== undefined) nextPrefs.tempThresholds = tempThresholds;
      if (humThresholds !== undefined) nextPrefs.humThresholds = humThresholds;
      if (notificationSpaTempThreshold !== undefined) {
        nextPrefs.notificationSpaTempThreshold = notificationSpaTempThreshold;
      }
      if (notificationHumidityThreshold !== undefined) {
        nextPrefs.notificationHumidityThreshold = notificationHumidityThreshold;
      }
      if (notificationTempMinThreshold !== undefined) {
        nextPrefs.notificationTempMinThreshold = notificationTempMinThreshold;
      }
      if (notificationTempMaxThreshold !== undefined) {
        nextPrefs.notificationTempMaxThreshold = notificationTempMaxThreshold;
      }
      if (notificationHumidityMinThreshold !== undefined) {
        nextPrefs.notificationHumidityMinThreshold =
          notificationHumidityMinThreshold;
      }
      if (notificationHumidityMaxThreshold !== undefined) {
        nextPrefs.notificationHumidityMaxThreshold =
          notificationHumidityMaxThreshold;
      }

      if (Object.keys(nextPrefs).length > 0) {
        update.widgetPreferences = nextPrefs as Prisma.InputJsonObject;
      }

      await tx.user.update({ where: { id: user.id }, data: update });
      return update;
    }, { maxWait: CONNECTION_TIMEOUT_MS, timeout: CONNECTION_TIMEOUT_MS + 5_000 });
    invalidateUserCache(user.clerkId);
    return ApiResponse.success({ success: true, preferences: data });
  } catch (e) {
    logger.error("Failed to update preferences", { error: String(e) });
    return ApiResponse.serverError();
  }
});
