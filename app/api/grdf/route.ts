import { withAuth } from '@/lib/api-middleware';
import { getGrdfData } from '@/lib/integrations/grdf';
import { ApiResponse } from '@/lib/api-response';
import { logger } from '@/lib/logger';
import { parseDateRange } from '@/lib/date-utils';

export const dynamic = 'force-dynamic';

export const GET = withAuth(async (request) => {
    const { start, end, startStr, endStr } = parseDateRange(request.url);

    try {
        const data = await getGrdfData(start, end);

        // Debug logging
        const estimates = data.filter(d => d.isEstimate).length;
        logger.debug(`[API/GRDF] Returning ${data.length} items. Estimates: ${estimates}. Range: ${startStr} to ${endStr}`);

        // Format response
        const formattedData = data.map(d => ({
            date: d.date.toISOString(),
            value: d.value,
            temp: d.temp,
            isEstimate: d.isEstimate
        }));

        const response = ApiResponse.success({
            dailyConsumption: formattedData
        });
        // Authenticated response: a shared cache must never serve it to another caller
        response.headers.set('Cache-Control', 'private, no-store');
        return response;
    } catch (error) {
        logger.error('[GRDF] Request failed', { error: String(error) });
        return ApiResponse.serverError();
    }
});
