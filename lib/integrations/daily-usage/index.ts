/** Daily usage — point d'entrée des compteurs d'usage quotidiens. */
export { syncDailyUsage, syncDailyUsageIfDue, getDailyUsage, MAX_CATCH_UP_DAYS } from './service';
export type { UsageSeries, DailyUsageSyncResult } from './service';
