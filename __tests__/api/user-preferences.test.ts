import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET, POST } from "@/app/api/user/preferences/route";
import { mockDeep } from "vitest-mock-extended";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { setMockUser, clearMockUsers, mockPrisma } from "../setup";
import { mockAsAdmin } from "../helpers/mock-auth";
import { ADMIN_USER } from "../helpers/test-users";
import * as userCache from "@/lib/user-cache";

const params = Promise.resolve({});
const mockTx = mockDeep<PrismaClient>();

describe("/api/user/preferences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMockUsers();
    mockAsAdmin();
    setMockUser(ADMIN_USER.clerkId, ADMIN_USER);
    // The route merges inside an interactive transaction, on the row it reads there.
    mockPrisma.$transaction.mockImplementation((async (run: (tx: typeof mockPrisma) => unknown) =>
      run(mockPrisma)) as never);
    mockPrisma.$queryRaw.mockResolvedValue([] as never);
    mockPrisma.user.findUniqueOrThrow.mockResolvedValue(ADMIN_USER as never);
    mockTx.$queryRaw.mockResolvedValue([] as never);
    mockTx.user.findUniqueOrThrow.mockResolvedValue(ADMIN_USER as never);
  });

  describe("GET", () => {
    it("returns user preferences", async () => {
      const req = new Request("http://localhost:3000/api/user/preferences");
      const res = await GET(req, { params });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.preferences).toEqual(ADMIN_USER.widgetPreferences);
    });
  });

  describe("POST", () => {
    it("updates widget order and invalidates cache", async () => {
      const payload = { widgetOrder: ["lights", "alarm", "temperature"] };
      const req = new Request("http://localhost:3000/api/user/preferences", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      const res = await POST(req, { params });
      expect(res.status).toBe(200);

      // Verify DB update
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: ADMIN_USER.id },
        data: {
          widgetPreferences: {
            widgetOrder: ["lights", "alarm", "temperature"],
          },
        },
      });

      // Verify cache invalidation
      expect(userCache.invalidateUserCache).toHaveBeenCalledWith(
        ADMIN_USER.clerkId,
      );
    });

    it("updates collapsed states", async () => {
      const payload = { collapsed: { lights: true, temperature: false } };
      const req = new Request("http://localhost:3000/api/user/preferences", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      const res = await POST(req, { params });
      expect(res.status).toBe(200);

      // Verify DB update
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: ADMIN_USER.id },
        data: {
          widgetPreferences: {
            ...ADMIN_USER.widgetPreferences,
            collapsed: { lights: true, temperature: false },
          },
        },
      });
    });

    it("updates hidden sensors", async () => {
      const payload = { hiddenSensors: ["sensor.temperature_salon", "sensor.somfy_salon_temperature"] };
      const req = new Request("http://localhost:3000/api/user/preferences", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      const res = await POST(req, { params });
      expect(res.status).toBe(200);

      // Verify DB update
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: ADMIN_USER.id },
        data: {
          widgetPreferences: {
            ...ADMIN_USER.widgetPreferences,
            hiddenSensors: ["sensor.temperature_salon", "sensor.somfy_salon_temperature"],
          },
        },
      });
    });

    it("B34: merges into the row read from the database, not the cached user", async () => {
      // Another instance saved the collapsed states; this instance still caches the old row.
      const savedElsewhere = {
        ...ADMIN_USER,
        widgetPreferences: { ...ADMIN_USER.widgetPreferences, collapsed: { lights: true } },
        notificationPreferences: { alarm: true },
      };
      mockTx.user.findUniqueOrThrow.mockResolvedValue(savedElsewhere as never);
      mockPrisma.$transaction.mockImplementation((async (run: (tx: typeof mockTx) => unknown) =>
        run(mockTx)) as never);
      const req = new Request("http://localhost:3000/api/user/preferences", {
        method: "POST",
        body: JSON.stringify({ hiddenWidgets: ["spa"], notificationPreferences: { spa: false } }),
      });

      const res = await POST(req, { params });

      expect(res.status).toBe(200);
      // Lock, then read, then write, all through the transaction client.
      const [lock] = mockTx.$queryRaw.mock.invocationCallOrder;
      const [read] = mockTx.user.findUniqueOrThrow.mock.invocationCallOrder;
      const [write] = mockTx.user.update.mock.invocationCallOrder;
      expect(lock).toBeLessThan(read);
      expect(read).toBeLessThan(write);
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
      expect(mockPrisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        maxWait: 10_000,
        timeout: 15_000,
      });
      expect(mockTx.user.update).toHaveBeenCalledWith({
        where: { id: ADMIN_USER.id },
        data: {
          notificationPreferences: { alarm: true, spa: false },
          widgetPreferences: {
            ...ADMIN_USER.widgetPreferences,
            collapsed: { lights: true },
            hiddenWidgets: ["spa"],
          },
        },
      });
    });

    it("rejects collapsed state updates with 400", async () => {
      const payload = { widgetId: "lights", collapsed: true };
      const req = new Request("http://localhost:3000/api/user/preferences", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      const res = await POST(req, { params });
      expect(res.status).toBe(400);
    });
  });
});
