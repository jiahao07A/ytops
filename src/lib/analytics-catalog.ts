// 首期支持的官方 Analytics 指标与维度目录：指标/维度白名单的单一事实源，
// 由同步、高维细分与配置校验共同派生，避免多处清单漂移。
export const CORE_ANALYTICS_METRICS = [
  "views",
  "engagedViews",
  "estimatedMinutesWatched",
  "averageViewDuration",
  "likes",
  "dislikes",
  "comments",
  "shares",
  "subscribersGained",
  "subscribersLost",
] as const;

export const REVENUE_ESTIMATE_METRIC = "estimatedRevenue";

export type AnalyticsMetric =
  (typeof CORE_ANALYTICS_METRICS)[number] | typeof REVENUE_ESTIMATE_METRIC;

export const SUPPORTED_ANALYSIS_DIMENSIONS = [
  "day",
  "video",
  "trafficSourceType",
  "deviceType",
  "country",
  "ageGroup",
  "gender",
  "subscribedStatus",
] as const;

export type AnalyticsDimension = (typeof SUPPORTED_ANALYSIS_DIMENSIONS)[number];
