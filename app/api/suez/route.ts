import { withAuth } from '@/lib/api-middleware';
import { getSuezData } from '@/lib/integrations/suez';
import { ApiResponse } from '@/lib/api-response';
import { logger } from '@/lib/logger';
import { parseDateRange } from '@/lib/date-utils';
import { canAccessHistory } from '@/lib/permissions';


export const dynamic = 'force-dynamic';

export const GET = withAuth(async (request, { user }) => {
    // 1. Permission check
    if (!canAccessHistory(user)) {
        logger.security('Blocked history access to Suez', { userEmail: user?.email });
        return ApiResponse.forbidden("Forbidden: You do not have permission to view history.");
    }

    // 2. Parse range
    const { start, end, startStr, endStr } = parseDateRange(request.url);

    try {
        // 3. Fetch processed water data
        const data = await getSuezData(start, end);

        // 4. Format consumption records with ISO string dates for serialization
        const formattedData = data.dailyConsumption.map(d => ({
            date: d.date.toISOString(),
            value: d.value,
            isEstimate: d.isEstimate
        }));



        logger.debug(`[API/Suez] Returning ${formattedData.length} items. Price: ${data.price} €/m³. Range: ${startStr} to ${endStr}`);

        // 5. Build and return standard response
        const response = ApiResponse.success({
            dailyConsumption: formattedData,
            price: data.price
        });
        
        // Cache for 1 hour, serve stale up to 2 hours
        // Authenticated response: a shared cache must never serve it to another caller
        response.headers.set('Cache-Control', 'private, no-store');
        return response;
    } catch (error) {
        logger.error('[Suez] Request failed', { error: String(error) });
        return ApiResponse.serverError();
    }
});
