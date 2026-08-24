import {
  getAnalyticsStatus,
  syncAnalytics,
  type AnalyticsData,
  type AnalyticsSyncDependencies,
  type AnalyticsSyncResult,
} from "./analytics.js";
import { AnalyticsServiceError } from "./errors.js";

export type AnalyticsReadMode = "cached" | "refresh" | "latest";
export type FreshnessState = "fresh" | "stale";

export interface AnalyticsFactsReadResult {
  success: true;
  channelId: string;
  mode: AnalyticsReadMode;
  freshness: FreshnessState;
  stale: boolean;
  dataAsOf?: string;
  lastSuccessAt?: string;
  state: AnalyticsSyncResult["state"];
  data: AnalyticsData;
  refresh: {
    attempted: boolean;
    status: "not-requested" | "completed" | "failed";
    error?: { kind: string; message: string; retryable: boolean };
  };
}

export interface AnalyticsFactsReadInput {
  channelId: string;
  mode?: AnalyticsReadMode;
  maxAgeHours?: number;
  days?: number;
  videoIds?: string[];
}

function isStale(
  dataAsOf: string | undefined,
  maxAgeHours: number,
  now: Date,
): boolean {
  if (dataAsOf === undefined) {
    return true;
  }
  const timestamp = Date.parse(dataAsOf);
  return (
    Number.isNaN(timestamp) ||
    now.getTime() - timestamp > maxAgeHours * 60 * 60 * 1000
  );
}

function validateMaxAge(maxAgeHours: number | undefined): number {
  const value = maxAgeHours ?? 24;
  if (!Number.isFinite(value) || value <= 0 || value > 8_760) {
    throw new AnalyticsServiceError(
      "缓存新鲜度窗口必须在 0 到 8760 小时之间。",
      "invalid-response",
      false,
    );
  }
  return value;
}

function hasFacts(result: AnalyticsSyncResult): boolean {
  return result.data.channelRows.length > 0 || result.data.videoRows.length > 0;
}

function hasUsableFacts(result: AnalyticsSyncResult): boolean {
  return (
    hasFacts(result) &&
    result.state.coverage !== "unavailable" &&
    result.state.coverage !== "permission-denied" &&
    result.data.coverage !== "unavailable" &&
    result.data.coverage !== "permission-denied"
  );
}

function failureFromState(
  state: AnalyticsSyncResult["state"],
): AnalyticsServiceError {
  const error = state.error;
  const kind = error?.kind;
  const supportedKind =
    kind === "quota" ||
    kind === "network" ||
    kind === "permission" ||
    kind === "credential" ||
    kind === "not-ready"
      ? kind
      : "network";
  return new AnalyticsServiceError(
    error?.message ?? "Analytics 刷新未完成。",
    supportedKind,
    error?.retryable ?? true,
  );
}

function failureFromRefreshResult(
  result: AnalyticsSyncResult,
): AnalyticsServiceError {
  if (result.state.error !== undefined) {
    return failureFromState(result.state);
  }
  if (result.state.coverage === "permission-denied") {
    return new AnalyticsServiceError(
      "当前 Analytics 刷新没有可用的授权数据。",
      "permission",
      false,
    );
  }
  return new AnalyticsServiceError(
    "本次 Analytics 刷新没有返回可用事实数据。",
    "not-ready",
    true,
  );
}

function resultFromData(
  input: AnalyticsFactsReadInput,
  result: AnalyticsSyncResult,
  mode: AnalyticsReadMode,
  maxAgeHours: number,
  now: Date,
  refresh: AnalyticsFactsReadResult["refresh"],
): AnalyticsFactsReadResult {
  const stale = isStale(result.data.dataAsOf, maxAgeHours, now);
  return {
    success: true,
    channelId: input.channelId,
    mode,
    freshness: stale ? "stale" : "fresh",
    stale,
    ...(result.data.dataAsOf === undefined
      ? {}
      : { dataAsOf: result.data.dataAsOf }),
    ...(result.state.lastSuccessAt === undefined
      ? {}
      : { lastSuccessAt: result.state.lastSuccessAt }),
    state: result.state,
    data: result.data,
    refresh,
  };
}

export async function readAnalyticsFacts(
  configPath: string,
  input: AnalyticsFactsReadInput,
  dependencies: AnalyticsSyncDependencies & { now?: () => Date } = {},
): Promise<AnalyticsFactsReadResult> {
  const mode = input.mode ?? "cached";
  const maxAgeHours = validateMaxAge(input.maxAgeHours);
  const now = (dependencies.now ?? (() => new Date()))();
  const cached = await getAnalyticsStatus(configPath, input.channelId);
  const cachedHasFacts = hasFacts(cached);

  if (mode === "cached") {
    if (!cachedHasFacts) {
      if (
        cached.state.status === "failed" &&
        cached.state.error !== undefined
      ) {
        throw failureFromState(cached.state);
      }
      throw new AnalyticsServiceError(
        "尚未有可用的 Analytics 事实，请先执行同步。",
        "not-ready",
        true,
      );
    }
    return resultFromData(input, cached, mode, maxAgeHours, now, {
      attempted: false,
      status: "not-requested",
    });
  }

  const refreshed = await syncAnalytics(configPath, input, dependencies);
  if (refreshed.state.status === "completed" && hasUsableFacts(refreshed)) {
    return resultFromData(input, refreshed, mode, maxAgeHours, now, {
      attempted: true,
      status: "completed",
    });
  }

  const refreshError = refreshed.state.error;
  const failure = failureFromRefreshResult(refreshed);
  if (mode === "latest") {
    throw failure;
  }
  if (!cachedHasFacts && !hasUsableFacts(refreshed)) {
    throw failure;
  }
  return resultFromData(
    input,
    hasUsableFacts(refreshed) ? refreshed : cached,
    mode,
    maxAgeHours,
    now,
    {
      attempted: true,
      status: "failed",
      ...(refreshError === undefined ? {} : { error: refreshError }),
    },
  );
}
