/**
 * API Request Validators
 * Zod schemas and helpers for strict input validation across all endpoints.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { ApiResponse } from "./api-response";
import { logger } from '@/lib/logger';

// ============================================
// Common Patterns
// ============================================

export const entityIdPattern = /^[a-z_]+\.[a-z0-9_]+$/;

export const cameraEntityIdPattern = /^camera\.[a-z0-9_]+$/;

export const arloCameraEntityIdPattern = /^camera\.aarlo_[a-z0-9_]+$/;

export const imageEntityIdPattern = /^image\.[a-z0-9_]+$/;

export const weatherEntityIdPattern = /^weather\.[a-z0-9_]+$/;

const domainPattern = /^[a-z_]+$/;

const servicePattern = /^[a-z_]+$/;

// ============================================
// Reusable Schemas
// ============================================

export const entityIdSchema = z.union([
  z.string().regex(entityIdPattern, "Invalid entity_id format").min(3).max(100),
  z.array(
    z
      .string()
      .regex(entityIdPattern, "Invalid entity_id format")
      .min(3)
      .max(100),
  ),
]);

export const domainSchema = z
  .string()
  .regex(domainPattern, "Invalid domain format")
  .min(2)
  .max(50);

export const serviceSchema = z
  .string()
  .regex(servicePattern, "Invalid service format")
  .min(2)
  .max(50);

// ============================================
// Endpoint-specific Schemas
// ============================================

export const callSchema = z.object({
  domain: domainSchema,
  service: serviceSchema,
  entity_id: entityIdSchema,
  service_data: z.record(z.string(), z.unknown()).optional(),
  return_response: z.boolean().optional(),
});

export const templateSchema = z.object({
  template: z
    .string()
    .min(1, "Template is required")
    .max(10000, "Template too long"),
});

/** Query of GET /api/ha/forecast: a weather entity and the forecast granularity. */
export const forecastQuerySchema = z.object({
  entity_id: z
    .string()
    .max(100)
    .regex(weatherEntityIdPattern, "Invalid entity_id: must be a weather entity"),
  type: z.enum(["daily", "hourly"]),
});

export type ForecastQuery = z.infer<typeof forecastQuerySchema>;

// ============================================
// User preferences
// ============================================

export const widgetPreferencesSchema = z
  .object({
    widgetOrder: z.array(z.string()).optional(),
    roomOrder: z.array(z.string()).optional(),
    floorOrder: z.array(z.string()).optional(),
    roomIcons: z.record(z.string(), z.string()).optional(),
    hiddenWidgets: z.array(z.string()).optional(),
    hiddenRooms: z.array(z.string()).optional(),
    hiddenSensors: z.array(z.string()).optional(),
    collapsed: z.record(z.string(), z.boolean()).optional(),
    tempThresholds: z
      .object({
        tempIndoorMinRed: z.number().optional(),
        tempIndoorMinOrange: z.number().optional(),
        tempIndoorMaxOrange: z.number().optional(),
        tempIndoorMaxRed: z.number().optional(),
        tempOutdoorMinRed: z.number().optional(),
        tempOutdoorMinOrange: z.number().optional(),
        tempOutdoorMaxOrange: z.number().optional(),
        tempOutdoorMaxRed: z.number().optional(),
      })
      .optional(),
    humThresholds: z
      .object({
        humIndoorMinRed: z.number().optional(),
        humIndoorMinOrange: z.number().optional(),
        humIndoorMaxOrange: z.number().optional(),
        humIndoorMaxRed: z.number().optional(),
        humOutdoorMinRed: z.number().optional(),
        humOutdoorMinOrange: z.number().optional(),
        humOutdoorMaxOrange: z.number().optional(),
        humOutdoorMaxRed: z.number().optional(),
      })
      .optional(),
    theme: z.string().max(32).optional(),
    notificationPreferences: z
      .object({
        alarm: z.boolean().optional(),
        lights: z.boolean().optional(),
        spa: z.boolean().optional(),
        fountain: z.boolean().optional(),
        feeder: z.boolean().optional(),
        humidity: z.boolean().optional(),
        motion: z.boolean().optional(),
        temperature: z.boolean().optional(),
        washingMachine: z.boolean().optional(),
        printer: z.boolean().optional(),
      })
      .optional(),
    notificationSpaTempThreshold: z.number().optional(),
    notificationHumidityThreshold: z.number().optional(),
    notificationTempMinThreshold: z.number().optional(),
    notificationTempMaxThreshold: z.number().optional(),
    notificationHumidityMinThreshold: z.number().optional(),
    notificationHumidityMaxThreshold: z.number().optional(),
  })
  .refine(
    (v) =>
      v.widgetOrder !== undefined ||
      v.roomOrder !== undefined ||
      v.floorOrder !== undefined ||
      v.roomIcons !== undefined ||
      v.hiddenWidgets !== undefined ||
      v.hiddenRooms !== undefined ||
      v.hiddenSensors !== undefined ||
      v.tempThresholds !== undefined ||
      v.humThresholds !== undefined ||
      v.theme !== undefined ||
      v.notificationPreferences !== undefined ||
      v.notificationSpaTempThreshold !== undefined ||
      v.notificationHumidityThreshold !== undefined ||
      v.notificationTempMinThreshold !== undefined ||
      v.notificationTempMaxThreshold !== undefined ||
      v.notificationHumidityMinThreshold !== undefined ||
      v.notificationHumidityMaxThreshold !== undefined ||
      v.collapsed !== undefined,
    { message: "No valid fields to update" },
  );

export const petkitFeedSchema = z
  .object({
    deviceId: z.number().int().positive(),
    amount1: z.number().int().min(0).max(100).optional().default(0),
    amount2: z.number().int().min(0).max(100).optional().default(0),
  })
  .refine((v) => v.amount1 > 0 || v.amount2 > 0, {
    message: "amount1 or amount2 must be greater than 0",
  });

// ============================================
// Home Assistant payloads
// ============================================

/**
 * Keys that let a service call target other entities than the validated `entity_id`.
 * WARNING: permissions are checked on `entity_id` only, so these keys must never reach HA.
 */
const TARGET_OVERRIDE_KEYS = new Set(["entity_id", "area_id", "device_id", "floor_id", "label_id", "target"]);

/**
 * Removes from service data every key that would override the checked target.
 *
 * @param serviceData - Free-form `data` / `service_data` sent by the client.
 * @returns A copy without targeting keys.
 */
export function stripTargetOverrides(
  serviceData: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(serviceData ?? {}).filter(([key]) => !TARGET_OVERRIDE_KEYS.has(key)),
  );
}

// ============================================
// Validation Helper
// ============================================

export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; error: NextResponse };

/** Body of POST /api/notifications/read: given ids, or every unread notification. */
export const markNotificationsReadSchema = z.object({
  ids: z.array(z.number().int().positive()).max(200).optional(),
});

/** A browser's Web Push subscription, as `PushSubscription.toJSON()` gives it. */
export const pushSubscriptionSchema = z.object({
  endpoint: z.url().startsWith("https://").max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(256),
  }),
});

/** Body of POST /api/push/unsubscribe. */
export const pushUnsubscribeSchema = z.object({
  endpoint: z.url().max(2048),
});

/**
 * Validate request body against a Zod schema.
 *
 * @param request - The incoming Request object.
 * @param schema - Zod schema to validate against.
 * @returns Success with parsed data OR failure with NextResponse error.
 */
export async function validateBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<ValidationResult<T>> {
  try {
    const body = await request.json();
    return parseWithSchema(body, schema);
  } catch {
    logger.warn("[Validation] Invalid JSON body");
    return {
      success: false,
      error: ApiResponse.badRequest("Invalid JSON body"),
    };
  }
}

/**
 * Validate query string parameters against a Zod schema. A repeated key keeps its last value.
 *
 * @param searchParams - Query parameters of the incoming request.
 * @param schema - Zod schema to validate against.
 * @returns Success with parsed data OR failure with a 400 response.
 */
export function validateQuery<T>(
  searchParams: URLSearchParams,
  schema: z.ZodType<T>,
): ValidationResult<T> {
  return parseWithSchema(Object.fromEntries(searchParams), schema);
}

function parseWithSchema<T>(input: unknown, schema: z.ZodType<T>): ValidationResult<T> {
  const result = schema.safeParse(input);
  if (result.success) return { success: true, data: result.data };

  const errors = result.error.issues.map((e) => ({
    field: e.path.join("."),
    message: e.message,
  }));
  logger.warn("[Validation] Request validation failed", { errors });
  return {
    success: false,
    error: ApiResponse.badRequest("Validation failed", errors),
  };
}
