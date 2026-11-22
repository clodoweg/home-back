import { ApiResponse } from '@/lib/api-response';
import { isApiEnabled } from '@/lib/settings';
import { hasHAConfig } from '@/lib/env';

/**
 * Health Check Endpoint
 *
 * Used by:
 * - Load balancers
 * - Uptime monitoring (UptimeRobot, Pingdom, etc.)
 * - Vercel edge network
 *
 * WARNING: public route (no withAuth). It answers the status only: the deployed commit would tell
 * anyone reading the public repository whether a given fix is live (audit L3). The deployed
 * version shows in the Vercel dashboard.
 *
 * @returns 200 when healthy, 503 when degraded or when the API is disabled.
 */
export async function GET() {
    // 🟢 Check if API is enabled globally
    const apiEnabled = await isApiEnabled();
    if (!apiEnabled) {
        return ApiResponse.success({ status: 'maintenance', message: 'API disabled by system settings' }, 503);
    }

    const checks = {
        database: true, // Could add Prisma connection check
        homeAssistant: hasHAConfig(),
        timestamp: new Date().toISOString(),
    };

    const allHealthy = Object.values(checks).every(v => v === true || typeof v === 'string');

    return ApiResponse.success(
        {
            status: allHealthy ? 'healthy' : 'degraded',
            checks,
        },
        allHealthy ? 200 : 503,
    );
}
