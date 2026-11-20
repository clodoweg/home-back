/** HA statistics — point d'entrée de l'intégration des statistiques long terme. */
export { getStatistics, statisticsQuerySchema, STATISTIC_PERIODS, STATISTIC_TYPES } from './service';
export type { StatisticRow, StatisticPeriod, StatisticsQuery } from './service';
