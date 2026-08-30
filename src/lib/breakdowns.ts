import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  type AnalyticsCoverageStatus,
  type AnalyticsMetric,
  type AnalyticsProvider,
  type AnalyticsRow,
} from "./analytics.js";
import {
  AUDIENCE_VIEWER_PERCENTAGE_METRIC,
  CORE_ANALYTICS_METRICS,
  REVENUE_CURRENCY,
  REVENUE_ESTIMATE_METRIC,
  SUPPORTED_ANALYSIS_DIMENSIONS,
} from "./analytics-catalog.js";
import {
  resolveRevenueOptIn,
  validateChannelOperationsConfig,
  updateAnalysisProfileOperationsConfig,
} from "./config.js";
import { AnalyticsServiceError, UserInputError } from "./errors.js";
import {
  getChannelAccessToken,
  type OAuthWorkflowDependencies,
} from "./oauth.js";

export const BREAKDOWN_METRICS = [
  ...CORE_ANALYTICS_METRICS,
  REVENUE_ESTIMATE_METRIC,
  AUDIENCE_VIEWER_PERCENTAGE_METRIC,
] as const;
export const BREAKDOWN_DIMENSIONS = SUPPORTED_ANALYSIS_DIMENSIONS;

export type BreakdownMetric = (typeof BREAKDOWN_METRICS)[number];
export type BreakdownDimension = (typeof BREAKDOWN_DIMENSIONS)[number];

export interface BreakdownProfile {
  metrics: BreakdownMetric[];
  dimensions: BreakdownDimension[];
  startDate: string;
  endDate: string;
  filters: Record<string, string>;
}

export interface BreakdownQueryInput {
  channelId: string;
  profileName?: string;
  profile?: Partial<BreakdownProfile>;
  revenueEligible?: boolean;
}

export interface BreakdownResult {
  success: boolean;
  channelId: string;
  source: "youtube-analytics-api";
  query: BreakdownProfile;
  coverage: AnalyticsCoverageStatus;
  reason?: string;
  rows: AnalyticsRow[];
  dataAsOf?: string;
  evidencePath?: string;
  error?: { kind: string; message: string; retryable: boolean };
}

export interface BreakdownDependencies extends Pick<
  OAuthWorkflowDependencies,
  "credentialStore" | "now"
> {
  provider?: AnalyticsProvider;
}

interface BreakdownPaths {
  root: string;
  evidence: string;
  result: string;
}

const breakdownProfileSchema = z
  .object({
    metrics: z.array(z.string().min(1)).min(1),
    dimensions: z.array(z.string().min(1)).min(1),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    filters: z.record(z.string(), z.string()),
  })
  .strict();

function isBreakdownMetric(value: string): value is BreakdownMetric {
  return (BREAKDOWN_METRICS as readonly string[]).includes(value);
}

function isBreakdownDimension(value: string): value is BreakdownDimension {
  return (BREAKDOWN_DIMENSIONS as readonly string[]).includes(value);
}

export function validateBreakdownQuery(
  profile: BreakdownProfile,
): BreakdownProfile {
  const parsed = breakdownProfileSchema.safeParse(profile);
  if (!parsed.success) {
    throw new UserInputError(
      "高维 Analytics 配置格式无效，请检查指标、维度和日期。",
    );
  }
  if (profile.metrics.some((metric) => !isBreakdownMetric(metric))) {
    throw new UserInputError("存在不支持的高维 Analytics 指标。");
  }
  if (
    profile.dimensions.some((dimension) => !isBreakdownDimension(dimension))
  ) {
    throw new UserInputError("存在不支持的高维 Analytics 维度。");
  }
  const hasAudienceDimension = profile.dimensions.some(
    (dimension) => dimension === "ageGroup" || dimension === "gender",
  );
  if (hasAudienceDimension && profile.dimensions.includes("video")) {
    throw new UserInputError(
      "受众维度不能与视频维度组合，请拆成独立的频道级查询。",
    );
  }
  if (
    profile.metrics.includes("estimatedRevenue") &&
    !profile.dimensions.includes("day")
  ) {
    throw new UserInputError(
      "收入估算指标必须按 day 维度查询，避免把估算值误当作视频明细。",
    );
  }
  if (profile.metrics.includes(AUDIENCE_VIEWER_PERCENTAGE_METRIC)) {
    const demographic = profile.dimensions.some(
      (dimension) =>
        dimension === "ageGroup" ||
        dimension === "gender" ||
        dimension === "video",
    );
    if (!demographic) {
      throw new UserInputError(
        "观众占比指标必须与年龄、性别或视频维度组合查询。",
      );
    }
  }
  if (profile.startDate > profile.endDate) {
    throw new UserInputError("高维 Analytics 开始日期不能晚于结束日期。");
  }
  const days =
    Math.floor(
      (Date.parse(`${profile.endDate}T00:00:00Z`) -
        Date.parse(`${profile.startDate}T00:00:00Z`)) /
        86_400_000,
    ) + 1;
  if (!Number.isInteger(days) || days < 1 || days > 3_650) {
    throw new UserInputError(
      "高维 Analytics 查询时间范围必须在 1 到 3650 天之间。",
    );
  }
  for (const [field, value] of Object.entries(profile.filters)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(field) || value.trim().length === 0) {
      throw new UserInputError("高维 Analytics 筛选条件格式无效。");
    }
  }
  return {
    metrics: [...new Set(profile.metrics)],
    dimensions: [...new Set(profile.dimensions)],
    startDate: profile.startDate,
    endDate: profile.endDate,
    filters: { ...profile.filters },
  };
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function defaultProfile(now: Date): BreakdownProfile {
  const end = dateOnly(now);
  const startDateValue = new Date(now);
  startDateValue.setUTCDate(startDateValue.getUTCDate() - 27);
  return {
    metrics: [...CORE_ANALYTICS_METRICS],
    dimensions: ["day"],
    startDate: dateOnly(startDateValue),
    endDate: end,
    filters: {},
  };
}

function datesForRange(
  range: string,
  now: Date,
): { startDate: string; endDate: string } {
  const days =
    range === "last-7-days"
      ? 7
      : range === "last-90-days"
        ? 90
        : range === "last-365-days"
          ? 365
          : 28;
  const endDate = dateOnly(now);
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { startDate: dateOnly(start), endDate };
}

async function loadProfile(
  configPath: string,
  name: string,
): Promise<BreakdownProfile | undefined> {
  const validated = await validateChannelOperationsConfig(configPath);
  const candidate = validated.config.analysisProfiles[name];
  if (candidate === undefined) return undefined;
  const dates = datesForRange(candidate.dateRange, new Date());
  return {
    metrics: candidate.metrics.filter(isBreakdownMetric),
    dimensions: candidate.dimensions.filter(isBreakdownDimension),
    startDate: dates.startDate,
    endDate: dates.endDate,
    filters: candidate.filters,
  };
}

export async function saveBreakdownProfile(
  configPath: string,
  name: string,
  profile: Omit<BreakdownProfile, "startDate" | "endDate"> & {
    dateRange?: string;
  },
  confirmed: boolean,
): Promise<{ updated: true; profileName: string }> {
  if (!confirmed) {
    throw new UserInputError("保存高维 Analytics 配置前必须明确确认差异。");
  }
  const dateRange = profile.dateRange ?? "last-28-days";
  const dates =
    dateRange === "last-7-days" ? 7 : dateRange === "last-90-days" ? 90 : 28;
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - dates + 1);
  const validated = validateBreakdownQuery({
    metrics: profile.metrics,
    dimensions: profile.dimensions,
    startDate: dateOnly(start),
    endDate: dateOnly(end),
    filters: profile.filters,
  });
  await updateAnalysisProfileOperationsConfig(configPath, {
    name,
    metrics: validated.metrics,
    dimensions: validated.dimensions,
    dateRange,
    filters: validated.filters,
  });
  return { updated: true, profileName: name };
}

async function resolvePaths(
  configPath: string,
  channelId: string,
  query: BreakdownProfile,
): Promise<BreakdownPaths> {
  const validated = await validateChannelOperationsConfig(configPath);
  const dataDirectory = resolve(
    dirname(validated.configPath),
    validated.config.global.dataDirectory,
  );
  const hash = createHash("sha256")
    .update(JSON.stringify(query))
    .digest("hex")
    .slice(0, 16);
  const root = resolve(dataDirectory, "breakdowns", channelId, hash);
  return {
    root,
    evidence: resolve(root, "evidence"),
    result: resolve(root, "result.json"),
  };
}

async function saveJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

export async function queryBreakdown(
  configPath: string,
  input: BreakdownQueryInput,
  dependencies: BreakdownDependencies = {},
): Promise<BreakdownResult> {
  const now = (dependencies.now ?? (() => new Date()))();
  const loaded =
    input.profileName === undefined
      ? undefined
      : await loadProfile(configPath, input.profileName);
  const base = loaded ?? defaultProfile(now);
  const query = validateBreakdownQuery({
    ...base,
    ...input.profile,
    metrics: input.profile?.metrics ?? base.metrics,
    dimensions: input.profile?.dimensions ?? base.dimensions,
    startDate: input.profile?.startDate ?? base.startDate,
    endDate: input.profile?.endDate ?? base.endDate,
    filters: { ...base.filters, ...(input.profile?.filters ?? {}) },
  });
  if (
    input.revenueEligible === false &&
    query.metrics.includes("estimatedRevenue")
  ) {
    return {
      success: false,
      channelId: input.channelId,
      source: "youtube-analytics-api",
      query,
      coverage: "permission-denied",
      reason: "当前频道不具备收入 Analytics 资格，结果不会伪装成零值。",
      rows: [],
    };
  }
  let revenueCurrency: string | undefined;
  if (query.metrics.includes(REVENUE_ESTIMATE_METRIC)) {
    const { config } = await validateChannelOperationsConfig(configPath);
    if (!resolveRevenueOptIn(config, input.channelId)) {
      return {
        success: false,
        channelId: input.channelId,
        source: "youtube-analytics-api",
        query,
        coverage: "permission-denied",
        reason:
          "货币分析权限未显式 opt-in（ADR 0003），收入查询在本地拒绝，不伪装成零值。",
        rows: [],
      };
    }
    revenueCurrency = REVENUE_CURRENCY;
  }
  const paths = await resolvePaths(configPath, input.channelId, query);
  try {
    const access = await getChannelAccessToken(
      configPath,
      input.channelId,
      dependencies,
    );
    const provider = dependencies.provider;
    if (provider === undefined) {
      throw new AnalyticsServiceError(
        "未配置高维 Analytics 官方适配器。",
        "not-ready",
        false,
      );
    }
    const result = await provider.query({
      accessToken: access.accessToken,
      channelId: access.channelId,
      startDate: query.startDate,
      endDate: query.endDate,
      metrics: query.metrics,
      dimensions: query.dimensions,
      filters: query.filters,
      ...(revenueCurrency === undefined ? {} : { currency: revenueCurrency }),
    });
    const fetchedAt = now.toISOString();
    const evidencePath = resolve(
      paths.evidence,
      `${fetchedAt.replace(/[^0-9A-Za-z]/g, "-")}.json`,
    );
    await saveJson(evidencePath, {
      source: "youtube-analytics-api",
      request: query,
      fetchedAt,
      response: result.raw,
    });
    const coverage: AnalyticsCoverageStatus = query.metrics.includes(
      "estimatedRevenue",
    )
      ? "estimated"
      : query.dimensions.some(
            (dimension) => dimension === "ageGroup" || dimension === "gender",
          )
        ? "partial"
        : (result.coverage ?? "complete");
    const output: BreakdownResult = {
      success: true,
      channelId: input.channelId,
      source: "youtube-analytics-api",
      query,
      coverage,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      rows: result.rows,
      ...(result.dataAsOf === undefined ? {} : { dataAsOf: result.dataAsOf }),
      evidencePath,
    };
    await saveJson(paths.result, output);
    return output;
  } catch (error) {
    const normalized =
      error instanceof AnalyticsServiceError
        ? {
            kind: error.kind,
            message: error.message,
            retryable: error.retryable,
          }
        : {
            kind: "unknown",
            message:
              error instanceof Error
                ? error.message
                : "高维 Analytics 查询失败。",
            retryable: true,
          };
    return {
      success: false,
      channelId: input.channelId,
      source: "youtube-analytics-api",
      query,
      coverage:
        normalized.kind === "permission" ? "permission-denied" : "unavailable",
      reason: normalized.message,
      rows: [],
      error: normalized,
    };
  }
}

export async function readBreakdownResult(
  configPath: string,
  input: BreakdownQueryInput,
): Promise<BreakdownResult> {
  const now = new Date();
  const loaded =
    input.profileName === undefined
      ? undefined
      : await loadProfile(configPath, input.profileName);
  const base = loaded ?? defaultProfile(now);
  const query = validateBreakdownQuery({
    ...base,
    ...input.profile,
    metrics: input.profile?.metrics ?? base.metrics,
    dimensions: input.profile?.dimensions ?? base.dimensions,
    startDate: input.profile?.startDate ?? base.startDate,
    endDate: input.profile?.endDate ?? base.endDate,
    filters: { ...base.filters, ...(input.profile?.filters ?? {}) },
  });
  const paths = await resolvePaths(configPath, input.channelId, query);
  try {
    return JSON.parse(await readFile(paths.result, "utf8")) as BreakdownResult;
  } catch {
    throw new UserInputError("尚未找到该高维 Analytics 查询的已保存结果。");
  }
}
