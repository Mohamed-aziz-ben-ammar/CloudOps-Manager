/**
 * Time ranges of the dashboard charts. Each range ends now; the bucket size keeps every
 * series to at most 168 points whatever the number of servers or samples.
 */
export const DASHBOARD_RANGES = {
  '1h': { seconds: 60 * 60, bucketSeconds: 60 },
  '6h': { seconds: 6 * 60 * 60, bucketSeconds: 5 * 60 },
  '24h': { seconds: 24 * 60 * 60, bucketSeconds: 15 * 60 },
  '7d': { seconds: 7 * 24 * 60 * 60, bucketSeconds: 60 * 60 },
} as const;

export type DashboardRange = keyof typeof DASHBOARD_RANGES;

export const DASHBOARD_RANGE_KEYS = Object.keys(DASHBOARD_RANGES) as DashboardRange[];

export const DEFAULT_DASHBOARD_RANGE: DashboardRange = '24h';
