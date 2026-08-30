import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  CORE_ANALYTICS_METRICS,
  REVENUE_ESTIMATE_METRIC,
  type AnalyticsDimension,
  type AnalyticsMetric,
} from "./analytics-catalog.js";
import {
  resolveRevenueOptIn,
  validateChannelOperationsConfig,
  type ChannelOperationsConfig,
} from "./config.js";
import { AnalyticsServiceError, UserInputError } from "./errors.js";
import {
  isFsCode,
  isRecord,
  loadValidatedJsonFile,
  readJsonResponse,
  saveJsonFile,
} from "./fs-json.js";
import { getInventoryStatus } from "./inventory.js";
import {
  getChannelAccessToken,
  type OAuthWorkflowDependencies,
} from "./oauth.js";

export { CORE_ANALYTICS_METRICS } from "./analytics-catalog.js";
export type {
  AnalyticsDimension,
  AnalyticsMetric,
} from "./analytics-catalog.js";

export const DEFAULT_ANALYTICS_BACKFILL_DAYS = 365;
export const MAX_ANALYTICS_BACKFILL_DAYS = 3_650;
export const ANALYTICS_PAGE_SIZE = 200;
export type AnalyticsPhase = "channel" | "video" | "audience" | "complete";

// 观众画像数据默认同步的维度组：频道级×日，每组一次官方查询。
const AUDIENCE_BREAKDOWN_GROUPS: AnalyticsDimension[][] = [
  ["day", "trafficSourceType"],
  ["day", "country"],
  ["day", "ageGroup", "gender"],
  ["day", "subscribedStatus"],
];

export type AnalyticsRunStatus =
  "not-started" | "running" | "partial" | "completed" | "failed";
export type AnalyticsCoverageStatus =
  | "complete"
  | "partial"
  | "unavailable"
  | "permission-denied"
  | "estimated"
  | "delayed";

export interface AnalyticsRow {
  dimensions: Record<string, string>;
  metrics: Record<string, number>;
}

export interface AnalyticsQuery {
  channelId: string;
  startDate: string;
  endDate: string;
  metrics: AnalyticsMetric[];
  dimensions: AnalyticsDimension[];
  filters?: Record<string, string>;
  currency?: string;
  startIndex?: number;
  maxResults?: number;
}

export interface AnalyticsProviderResult {
  rows: AnalyticsRow[];
  raw: unknown;
  dataAsOf?: string;
  coverage?: AnalyticsCoverageStatus;
  reason?: string;
  nextStartIndex?: number;
}

export interface AnalyticsProvider {
  query(
    input: AnalyticsQuery & { accessToken: string },
  ): Promise<AnalyticsProviderResult>;
}

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

const REPORTS_ENDPOINT = "https://youtubeanalytics.googleapis.com/v2/reports";

// 内部维度目录使用面向配置的名称；官方 API 的流量来源维度/筛选名为
// insightTrafficSourceType，其余维度名与官方一致。
const OFFICIAL_DIMENSION_NAMES: Record<string, string> = {
  trafficSourceType: "insightTrafficSourceType",
};

function toOfficialAnalyticsName(name: string): string {
  return OFFICIAL_DIMENSION_NAMES[name] ?? name;
}

export class GoogleAnalyticsProvider implements AnalyticsProvider {
  constructor(
    private readonly fetcher: Fetcher = globalThis.fetch.bind(globalThis),
  ) {}

  async query(
    input: AnalyticsQuery & { accessToken: string },
  ): Promise<AnalyticsProviderResult> {
    const startIndex = input.startIndex ?? 1;
    if (!Number.isInteger(startIndex) || startIndex < 1) {
      throw new UserInputError("Analytics 分页起始索引必须从 1 开始。");
    }
    const url = new URL(REPORTS_ENDPOINT);
    const params = new URLSearchParams({
      ids: `channel==${input.channelId}`,
      startDate: input.startDate,
      endDate: input.endDate,
      metrics: input.metrics.join(","),
      dimensions: input.dimensions.map(toOfficialAnalyticsName).join(","),
      maxResults: String(input.maxResults ?? ANALYTICS_PAGE_SIZE),
      startIndex: String(startIndex),
    });
    if (input.filters !== undefined) {
      const filters = Object.entries(input.filters)
        .map(([key, value]) => [toOfficialAnalyticsName(key), value])
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}==${value}`)
        .join(";");
      if (filters.length > 0) {
        params.set("filters", filters);
      }
    }
    if (input.currency !== undefined) {
      params.set("currency", input.currency);
    }
    url.search = params.toString();

    let response: Response;
    try {
      response = await this.fetcher(url, {
        headers: { authorization: `Bearer ${input.accessToken}` },
      });
    } catch {
      throw new AnalyticsServiceError(
        "读取官方 Analytics 时网络连接失败。",
        "network",
        true,
      );
    }

    const payload = await readJsonResponse(response);
    if (!response.ok) {
      throw classifyAnalyticsResponseError(response.status, payload);
    }
    return parseAnalyticsResponse(payload, input);
  }
}

export interface AnalyticsEvidenceReference {
  path: string;
  phase: AnalyticsPhase;
  fetchedAt: string;
  request: Omit<AnalyticsQuery, "accessToken">;
}

export interface AnalyticsSyncState {
  version: 1;
  channelId: string;
  status: AnalyticsRunStatus;
  phase: AnalyticsPhase;
  requestedDays: number;
  startDate: string;
  endDate: string;
  metrics: AnalyticsMetric[];
  progress: { pages: number; rows: number };
  checkpoint: {
    channelStartIndex: number;
    videoStartIndex: number;
    audience?: { group: number; startIndex: number };
  };
  coverage: AnalyticsCoverageStatus;
  audienceCoverage?: AnalyticsCoverageStatus;
  revenueOptIn?: boolean;
  updatedAt: string;
  startedAt?: string;
  lastSuccessAt?: string;
  dataAsOf?: string;
  error?: { kind: string; message: string; retryable: boolean };
}

export interface AnalyticsData {
  version: 1;
  channelId: string;
  source: "youtube-analytics-api";
  channelRows: AnalyticsRow[];
  videoRows: AnalyticsRow[];
  audienceRows?: AnalyticsRow[];
  evidence: AnalyticsEvidenceReference[];
  coverage: AnalyticsCoverageStatus;
  startDate: string;
  endDate: string;
  dataAsOf?: string;
  updatedAt?: string;
}

export interface AnalyticsSyncResult {
  channelId: string;
  state: AnalyticsSyncState;
  data: AnalyticsData;
}

export interface AnalyticsSyncDependencies extends Pick<
  OAuthWorkflowDependencies,
  "credentialStore" | "now"
> {
  provider?: AnalyticsProvider;
}

interface AnalyticsPaths {
  root: string;
  state: string;
  data: string;
  evidence: string;
  operationsConfig: ChannelOperationsConfig;
}

const rowSchema = z
  .object({
    dimensions: z.record(z.string(), z.string()),
    metrics: z.record(z.string(), z.number().finite()),
  })
  .strict();

const legacyStartIndexSchema = z.preprocess(
  (value) => (value === 0 ? 1 : value),
  z.number().int().positive(),
);

const evidenceSchema = z
  .object({
    path: z.string().min(1),
    phase: z.enum(["channel", "video", "audience", "complete"]),
    fetchedAt: z.string().min(1),
    request: z
      .object({
        channelId: z.string().min(1),
        startDate: z.string().min(1),
        endDate: z.string().min(1),
        metrics: z.array(z.string().min(1)),
        dimensions: z.array(z.string().min(1)),
        filters: z.record(z.string(), z.string()).optional(),
        currency: z.string().min(1).optional(),
        startIndex: legacyStartIndexSchema.optional(),
        maxResults: z.number().int().positive().optional(),
      })
      .strict(),
  })
  .strict();

const analyticsStateSchema = z
  .object({
    version: z.literal(1),
    channelId: z.string().min(1),
    status: z.enum([
      "not-started",
      "running",
      "partial",
      "completed",
      "failed",
    ]),
    phase: z.enum(["channel", "video", "audience", "complete"]),
    requestedDays: z.number().int().min(1).max(MAX_ANALYTICS_BACKFILL_DAYS),
    startDate: z.string().min(1),
    endDate: z.string().min(1),
    metrics: z.array(z.string().min(1)),
    progress: z
      .object({
        pages: z.number().int().nonnegative(),
        rows: z.number().int().nonnegative(),
      })
      .strict(),
    checkpoint: z
      .object({
        channelStartIndex: legacyStartIndexSchema,
        videoStartIndex: legacyStartIndexSchema,
        audience: z
          .object({
            group: z.number().int().nonnegative(),
            startIndex: legacyStartIndexSchema,
          })
          .strict()
          .optional(),
      })
      .strict(),
    coverage: z.enum([
      "complete",
      "partial",
      "unavailable",
      "permission-denied",
      "estimated",
      "delayed",
    ]),
    audienceCoverage: z
      .enum([
        "complete",
        "partial",
        "unavailable",
        "permission-denied",
        "estimated",
        "delayed",
      ])
      .optional(),
    revenueOptIn: z.boolean().optional(),
    updatedAt: z.string().min(1),
    startedAt: z.string().min(1).optional(),
    lastSuccessAt: z.string().min(1).optional(),
    dataAsOf: z.string().min(1).optional(),
    error: z
      .object({
        kind: z.string().min(1),
        message: z.string().min(1),
        retryable: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict() as unknown as z.ZodType<AnalyticsSyncState>;

const analyticsDataSchema = z
  .object({
    version: z.literal(1),
    channelId: z.string().min(1),
    source: z.literal("youtube-analytics-api"),
    channelRows: z.array(rowSchema),
    videoRows: z.array(rowSchema),
    audienceRows: z.array(rowSchema).optional(),
    evidence: z.array(evidenceSchema),
    coverage: z.enum([
      "complete",
      "partial",
      "unavailable",
      "permission-denied",
      "estimated",
      "delayed",
    ]),
    startDate: z.string().min(1),
    endDate: z.string().min(1),
    dataAsOf: z.string().min(1).optional(),
    updatedAt: z.string().min(1).optional(),
  })
  .strict() as unknown as z.ZodType<AnalyticsData>;

function defaultState(
  channelId: string,
  days: number,
  startDate: string,
  endDate: string,
  metrics: AnalyticsMetric[],
  now: string,
): AnalyticsSyncState {
  return {
    version: 1,
    channelId,
    status: "not-started",
    phase: "channel",
    requestedDays: days,
    startDate,
    endDate,
    metrics,
    progress: { pages: 0, rows: 0 },
    checkpoint: {
      channelStartIndex: 1,
      videoStartIndex: 1,
      audience: { group: 0, startIndex: 1 },
    },
    coverage: "partial",
    updatedAt: now,
  };
}

function normalizeCheckpoint(
  checkpoint: AnalyticsSyncState["checkpoint"],
): AnalyticsSyncState["checkpoint"] {
  return {
    channelStartIndex:
      checkpoint.channelStartIndex === 0 ? 1 : checkpoint.channelStartIndex,
    videoStartIndex:
      checkpoint.videoStartIndex === 0 ? 1 : checkpoint.videoStartIndex,
    audience: checkpoint.audience ?? { group: 0, startIndex: 1 },
  };
}

function defaultData(
  channelId: string,
  startDate: string,
  endDate: string,
): AnalyticsData {
  return {
    version: 1,
    channelId,
    source: "youtube-analytics-api",
    channelRows: [],
    videoRows: [],
    evidence: [],
    coverage: "partial",
    startDate,
    endDate,
  };
}

function loadJson<T>(
  path: string,
  fallback: T,
  schema: z.ZodType<T>,
): Promise<T> {
  return loadValidatedJsonFile(path, fallback, schema, {
    corrupt: () =>
      new AnalyticsServiceError(
        "本机 Analytics 数据文件格式无效，请保留原始证据后重新同步。",
        "invalid-response",
        false,
      ),
    unreadable: () =>
      new AnalyticsServiceError(
        "无法读取本机 Analytics 数据文件。",
        "network",
        true,
      ),
  });
}

async function saveJson(path: string, value: unknown): Promise<void> {
  await saveJsonFile(path, value);
}

async function resolveAnalyticsPaths(
  configPath: string,
  channelId: string,
): Promise<AnalyticsPaths> {
  if (!/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) {
    throw new UserInputError("频道 ID 必须是有效的 YouTube 频道 ID。");
  }
  const validated = await validateChannelOperationsConfig(configPath);
  const dataDirectory = resolve(
    dirname(validated.configPath),
    validated.config.global.dataDirectory,
  );
  const root = resolve(dataDirectory, "analytics", channelId);
  return {
    root,
    state: resolve(root, "sync-state.json"),
    data: resolve(root, "data.json"),
    evidence: resolve(root, "evidence"),
    operationsConfig: validated.config,
  };
}

function parseDateDays(days: number | undefined): number {
  const value = days ?? DEFAULT_ANALYTICS_BACKFILL_DAYS;
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_ANALYTICS_BACKFILL_DAYS
  ) {
    throw new UserInputError(
      `Analytics 回填天数必须在 1 到 ${MAX_ANALYTICS_BACKFILL_DAYS} 之间。`,
    );
  }
  return value;
}

function dateRange(
  now: Date,
  days: number,
): { startDate: string; endDate: string } {
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { startDate: toDateOnly(start), endDate: toDateOnly(end) };
}

function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function rowKey(row: AnalyticsRow): string {
  return JSON.stringify([
    Object.entries(row.dimensions).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  ]);
}

function mergeRows(
  existing: AnalyticsRow[],
  incoming: AnalyticsRow[],
): AnalyticsRow[] {
  const values = new Map(existing.map((row) => [rowKey(row), row]));
  for (const row of incoming) {
    values.set(rowKey(row), row);
  }
  return [...values.values()];
}

function nextCoverage(
  current: AnalyticsCoverageStatus,
  incoming: AnalyticsCoverageStatus | undefined,
): AnalyticsCoverageStatus {
  if (incoming === undefined) {
    return current;
  }
  if (current === "partial") {
    return incoming;
  }
  if (incoming === "complete" && current !== "complete") {
    return current;
  }
  const priority: AnalyticsCoverageStatus[] = [
    "complete",
    "partial",
    "delayed",
    "estimated",
    "permission-denied",
    "unavailable",
  ];
  return priority.indexOf(incoming) > priority.indexOf(current)
    ? incoming
    : current;
}

async function saveEvidence(
  paths: AnalyticsPaths,
  phase: AnalyticsPhase,
  request: Omit<AnalyticsQuery, "accessToken">,
  raw: unknown,
  fetchedAt: string,
): Promise<string> {
  const fileName = `${fetchedAt.replace(/[^0-9A-Za-z]/g, "-")}-${phase}-${Date.now()}.json`;
  const path = resolve(paths.evidence, fileName);
  await saveJson(path, {
    source: "youtube-analytics-api",
    phase,
    request,
    fetchedAt,
    response: raw,
  });
  return path;
}

export async function getAnalyticsStatus(
  configPath: string,
  channelId: string,
): Promise<AnalyticsSyncResult> {
  const paths = await resolveAnalyticsPaths(configPath, channelId);
  const now = new Date().toISOString();
  const state = await loadJson(
    paths.state,
    defaultState(
      channelId,
      DEFAULT_ANALYTICS_BACKFILL_DAYS,
      "",
      "",
      [...CORE_ANALYTICS_METRICS],
      now,
    ),
    analyticsStateSchema,
  );
  const data = await loadJson(
    paths.data,
    defaultData(channelId, state.startDate, state.endDate),
    analyticsDataSchema,
  );
  return { channelId, state, data };
}

export async function queryAnalytics(
  configPath: string,
  channelId: string,
): Promise<AnalyticsSyncResult> {
  return getAnalyticsStatus(configPath, channelId);
}

export interface DerivedAnalyticsRow {
  dimensions: Record<string, string>;
  metrics: Record<string, number>;
  derived: {
    rpmPerThousandEngagedViews?: number;
    likeToDislikeRatio?: number;
  };
}

/**
 * 读取时派生指标（ADR 0002）：仓库只存原始量，RPM 与赞踩比不落盘；
 * 分母缺失或为零时省略派生值，绝不把缺失伪装成零。
 */
export function deriveAnalyticsFacts(
  rows: AnalyticsRow[],
): DerivedAnalyticsRow[] {
  return rows.map((row) => {
    const derived: DerivedAnalyticsRow["derived"] = {};
    const { estimatedRevenue, engagedViews, likes, dislikes } = row.metrics;
    if (
      typeof estimatedRevenue === "number" &&
      typeof engagedViews === "number" &&
      engagedViews > 0
    ) {
      derived.rpmPerThousandEngagedViews =
        (estimatedRevenue / engagedViews) * 1000;
    }
    if (
      typeof likes === "number" &&
      typeof dislikes === "number" &&
      dislikes > 0
    ) {
      derived.likeToDislikeRatio = likes / dislikes;
    }
    return { dimensions: row.dimensions, metrics: row.metrics, derived };
  });
}

export async function syncAnalytics(
  configPath: string,
  input: {
    channelId: string;
    days?: number;
    videoIds?: string[];
    metrics?: AnalyticsMetric[];
    maxWorkUnits?: number;
  },
  dependencies: AnalyticsSyncDependencies = {},
): Promise<AnalyticsSyncResult> {
  const days = parseDateDays(input.days);
  const nowFactory = dependencies.now ?? (() => new Date());
  const range = dateRange(nowFactory(), days);
  const metrics = input.metrics ?? [...CORE_ANALYTICS_METRICS];
  if (
    metrics.length === 0 ||
    metrics.some(
      (metric) =>
        !(CORE_ANALYTICS_METRICS as readonly string[]).includes(metric),
    )
  ) {
    throw new UserInputError("Analytics 指标必须来自首期支持的核心指标目录。");
  }
  const paths = await resolveAnalyticsPaths(configPath, input.channelId);
  const revenueOptIn = resolveRevenueOptIn(
    paths.operationsConfig,
    input.channelId,
  );
  // 货币 opt-in 开启时，核心两阶段自动携带收入指标并以显式 USD 请求；
  // 观众画像组不携带收入，避免把估算值混入结构口径（ADR 0003）。
  const syncMetrics: AnalyticsMetric[] = revenueOptIn
    ? [...metrics, REVENUE_ESTIMATE_METRIC]
    : metrics;
  const now = nowFactory().toISOString();
  const previousState = await loadJson(
    paths.state,
    defaultState(
      input.channelId,
      days,
      range.startDate,
      range.endDate,
      metrics,
      now,
    ),
    analyticsStateSchema,
  );
  let state = previousState;
  let data = await loadJson(
    paths.data,
    defaultData(input.channelId, range.startDate, range.endDate),
    analyticsDataSchema,
  );
  const canResume =
    input.days === undefined &&
    (previousState.status === "partial" || previousState.status === "failed") &&
    previousState.startDate === range.startDate &&
    previousState.endDate === range.endDate;
  if (!canResume) {
    state = {
      ...defaultState(
        input.channelId,
        days,
        range.startDate,
        range.endDate,
        metrics,
        now,
      ),
      status: "running",
      startedAt: now,
      revenueOptIn,
      ...(previousState.lastSuccessAt === undefined
        ? {}
        : { lastSuccessAt: previousState.lastSuccessAt }),
      ...(previousState.dataAsOf === undefined
        ? {}
        : { dataAsOf: previousState.dataAsOf }),
    };
  } else {
    state = {
      ...previousState,
      checkpoint: normalizeCheckpoint(previousState.checkpoint),
      status: "running",
      updatedAt: now,
      error: undefined,
      revenueOptIn,
    };
  }
  await saveJson(paths.state, state);

  let access: { channelId: string; accessToken: string };
  try {
    access = await getChannelAccessToken(
      configPath,
      input.channelId,
      dependencies,
    );
  } catch (error) {
    return finishAnalyticsFailure(state, data, paths, now, error);
  }

  const provider = dependencies.provider ?? new GoogleAnalyticsProvider();
  let videoIds = [...new Set(input.videoIds ?? [])];
  if (input.videoIds === undefined) {
    try {
      const inventory = await getInventoryStatus(configPath, input.channelId);
      videoIds = [...new Set(inventory.data.videos.map((video) => video.id))];
    } catch {
      // Analytics remains queryable at channel level when inventory is unavailable.
    }
  }
  let workUnits = 0;
  const canContinue = () =>
    input.maxWorkUnits === undefined || workUnits < input.maxWorkUnits;
  try {
    while (state.phase === "channel" && canContinue()) {
      const request: AnalyticsQuery = {
        channelId: access.channelId,
        startDate: state.startDate,
        endDate: state.endDate,
        metrics: syncMetrics,
        dimensions: ["day"],
        ...(revenueOptIn ? { currency: "USD" } : {}),
        startIndex: state.checkpoint.channelStartIndex,
        maxResults: ANALYTICS_PAGE_SIZE,
      };
      const result = await provider.query({
        ...request,
        accessToken: access.accessToken,
      });
      const fetchedAt = nowFactory().toISOString();
      const evidencePath = await saveEvidence(
        paths,
        "channel",
        request,
        result.raw,
        fetchedAt,
      );
      data = {
        ...data,
        startDate: state.startDate,
        endDate: state.endDate,
        channelRows: mergeRows(data.channelRows, result.rows),
        evidence: [
          ...data.evidence,
          { path: evidencePath, phase: "channel", fetchedAt, request },
        ],
        coverage: nextCoverage(data.coverage, result.coverage),
        dataAsOf: result.dataAsOf ?? fetchedAt,
        updatedAt: fetchedAt,
      };
      state = {
        ...state,
        checkpoint: {
          ...state.checkpoint,
          channelStartIndex:
            result.nextStartIndex ?? state.checkpoint.channelStartIndex,
        },
        progress: {
          pages: state.progress.pages + 1,
          rows: state.progress.rows + result.rows.length,
        },
        coverage: nextCoverage(state.coverage, result.coverage),
        dataAsOf: result.dataAsOf ?? fetchedAt,
        updatedAt: fetchedAt,
      };
      await saveJson(paths.data, data);
      await saveJson(paths.state, state);
      workUnits += 1;
      if (result.nextStartIndex === undefined) {
        state = { ...state, phase: "video" };
        break;
      }
    }

    while (state.phase === "video" && canContinue()) {
      const request: AnalyticsQuery = {
        channelId: access.channelId,
        startDate: state.startDate,
        endDate: state.endDate,
        metrics: syncMetrics,
        dimensions: ["video"],
        ...(revenueOptIn ? { currency: "USD" } : {}),
        ...(videoIds.length === 0
          ? {}
          : { filters: { video: videoIds.join(",") } }),
        startIndex: state.checkpoint.videoStartIndex,
        maxResults: ANALYTICS_PAGE_SIZE,
      };
      const result = await provider.query({
        ...request,
        accessToken: access.accessToken,
      });
      const fetchedAt = nowFactory().toISOString();
      const evidencePath = await saveEvidence(
        paths,
        "video",
        request,
        result.raw,
        fetchedAt,
      );
      data = {
        ...data,
        startDate: state.startDate,
        endDate: state.endDate,
        videoRows: mergeRows(data.videoRows, result.rows),
        evidence: [
          ...data.evidence,
          { path: evidencePath, phase: "video", fetchedAt, request },
        ],
        coverage: nextCoverage(data.coverage, result.coverage),
        dataAsOf: result.dataAsOf ?? fetchedAt,
        updatedAt: fetchedAt,
      };
      state = {
        ...state,
        checkpoint: {
          ...state.checkpoint,
          videoStartIndex:
            result.nextStartIndex ?? state.checkpoint.videoStartIndex,
        },
        progress: {
          pages: state.progress.pages + 1,
          rows: state.progress.rows + result.rows.length,
        },
        coverage: nextCoverage(state.coverage, result.coverage),
        dataAsOf: result.dataAsOf ?? fetchedAt,
        updatedAt: fetchedAt,
      };
      await saveJson(paths.data, data);
      await saveJson(paths.state, state);
      workUnits += 1;
      if (result.nextStartIndex === undefined) {
        state = { ...state, phase: "audience" };
        break;
      }
    }

    while (state.phase === "audience" && canContinue()) {
      const audienceCheckpoint = state.checkpoint.audience ?? {
        group: 0,
        startIndex: 1,
      };
      if (audienceCheckpoint.group >= AUDIENCE_BREAKDOWN_GROUPS.length) {
        state = { ...state, phase: "complete" };
        break;
      }
      const dimensions =
        AUDIENCE_BREAKDOWN_GROUPS[audienceCheckpoint.group] ?? [];
      const request: AnalyticsQuery = {
        channelId: access.channelId,
        startDate: state.startDate,
        endDate: state.endDate,
        metrics,
        dimensions,
        startIndex: audienceCheckpoint.startIndex,
        maxResults: ANALYTICS_PAGE_SIZE,
      };
      const fetchedAt = nowFactory().toISOString();
      try {
        const result = await provider.query({
          ...request,
          accessToken: access.accessToken,
        });
        const evidencePath = await saveEvidence(
          paths,
          "audience",
          request,
          result.raw,
          fetchedAt,
        );
        data = {
          ...data,
          startDate: state.startDate,
          endDate: state.endDate,
          audienceRows: mergeRows(data.audienceRows ?? [], result.rows),
          evidence: [
            ...data.evidence,
            { path: evidencePath, phase: "audience", fetchedAt, request },
          ],
          coverage: nextCoverage(data.coverage, result.coverage),
          dataAsOf: result.dataAsOf ?? fetchedAt,
          updatedAt: fetchedAt,
        };
        state = {
          ...state,
          audienceCoverage: nextCoverage(
            state.audienceCoverage ?? "partial",
            result.coverage,
          ),
          checkpoint: {
            ...state.checkpoint,
            audience:
              result.nextStartIndex === undefined
                ? {
                    group: audienceCheckpoint.group + 1,
                    startIndex: 1,
                  }
                : {
                    group: audienceCheckpoint.group,
                    startIndex: result.nextStartIndex,
                  },
          },
          progress: {
            pages: state.progress.pages + 1,
            rows: state.progress.rows + result.rows.length,
          },
          dataAsOf: result.dataAsOf ?? fetchedAt,
          updatedAt: fetchedAt,
        };
        await saveJson(paths.data, data);
        await saveJson(paths.state, state);
        workUnits += 1;
        if (
          result.nextStartIndex === undefined &&
          audienceCheckpoint.group + 1 >= AUDIENCE_BREAKDOWN_GROUPS.length
        ) {
          state = { ...state, phase: "complete" };
          break;
        }
      } catch (error) {
        // 单个画像组的失败只降级画像覆盖状态，不影响已取得的核心事实。
        const normalized = normalizeAnalyticsError(error);
        state = {
          ...state,
          audienceCoverage: nextCoverage(
            state.audienceCoverage ?? "partial",
            normalized.kind === "permission"
              ? "permission-denied"
              : "unavailable",
          ),
          checkpoint: {
            ...state.checkpoint,
            audience: {
              group: audienceCheckpoint.group + 1,
              startIndex: 1,
            },
          },
          updatedAt: fetchedAt,
        };
        await saveJson(paths.state, state);
        workUnits += 1;
      }
    }

    const complete = state.phase === "complete";
    const completedAt = nowFactory().toISOString();
    state = {
      ...state,
      status: complete ? "completed" : "partial",
      updatedAt: completedAt,
      ...(complete
        ? {
            lastSuccessAt: completedAt,
            dataAsOf: data.dataAsOf ?? completedAt,
            error: undefined,
          }
        : {
            error: {
              kind: "checkpoint",
              message: "本次 Analytics 同步已保存检查点，可继续执行。",
              retryable: true,
            },
          }),
    };
    data = {
      ...data,
      updatedAt: completedAt,
      dataAsOf: data.dataAsOf ?? completedAt,
    };
    await saveJson(paths.state, state);
    await saveJson(paths.data, data);
    return { channelId: input.channelId, state, data };
  } catch (error) {
    return finishAnalyticsFailure(
      state,
      data,
      paths,
      nowFactory().toISOString(),
      error,
    );
  }
}

async function finishAnalyticsFailure(
  state: AnalyticsSyncState,
  data: AnalyticsData,
  paths: AnalyticsPaths,
  now: string,
  error: unknown,
): Promise<AnalyticsSyncResult> {
  const normalized = normalizeAnalyticsError(error);
  const nextState: AnalyticsSyncState = {
    ...state,
    status:
      data.channelRows.length > 0 || data.videoRows.length > 0
        ? "partial"
        : "failed",
    coverage:
      normalized.kind === "permission" ? "permission-denied" : "unavailable",
    updatedAt: now,
    error: normalized,
  };
  await saveJson(paths.state, nextState);
  return { channelId: state.channelId, state: nextState, data };
}

function normalizeAnalyticsError(error: unknown): {
  kind: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof AnalyticsServiceError) {
    return {
      kind: error.kind,
      message: error.message,
      retryable: error.retryable,
    };
  }
  if (error instanceof Error) {
    return { kind: "unknown", message: error.message, retryable: true };
  }
  return { kind: "unknown", message: "Analytics 同步失败。", retryable: true };
}

function classifyAnalyticsResponseError(
  status: number,
  payload: unknown,
): AnalyticsServiceError {
  const reason = extractApiReason(payload);
  if (status === 401) {
    return new AnalyticsServiceError(
      "Analytics OAuth 凭据无效或已过期，请重新完成授权。",
      "credential",
      false,
    );
  }
  if (status === 403 && /quota/i.test(reason ?? "")) {
    return new AnalyticsServiceError(
      "Analytics 官方 API 配额不足，请稍后重试或调整配额预算。",
      "quota",
      true,
    );
  }
  if (status === 403) {
    return new AnalyticsServiceError(
      "当前 OAuth 授权不包含 Analytics 读取权限或频道不具备该资格。",
      "permission",
      false,
    );
  }
  if (status === 429) {
    return new AnalyticsServiceError(
      "Analytics 请求触发配额限制。",
      "quota",
      true,
    );
  }
  if (status >= 500) {
    return new AnalyticsServiceError(
      "Analytics 官方 API 暂时不可用。",
      "network",
      true,
    );
  }
  return new AnalyticsServiceError(
    "Analytics 官方 API 请求失败。",
    "network",
    false,
  );
}

function extractApiReason(payload: unknown): string | undefined {
  if (
    !isRecord(payload) ||
    !isRecord(payload.error) ||
    !Array.isArray(payload.error.errors)
  ) {
    return undefined;
  }
  const first = payload.error.errors.find(isRecord);
  return first === undefined || typeof first.reason !== "string"
    ? undefined
    : first.reason;
}

function parseAnalyticsResponse(
  payload: unknown,
  input: AnalyticsQuery,
): AnalyticsProviderResult {
  if (
    !isRecord(payload) ||
    !Array.isArray(payload.columnHeaders) ||
    !Array.isArray(payload.rows)
  ) {
    throw new AnalyticsServiceError(
      "Analytics 官方 API 返回格式无效。",
      "invalid-response",
      false,
    );
  }
  const headers = payload.columnHeaders.filter(isRecord).map((header) => ({
    name: typeof header.name === "string" ? header.name : undefined,
    type: typeof header.columnType === "string" ? header.columnType : undefined,
  }));
  if (headers.some((header) => header.name === undefined)) {
    throw new AnalyticsServiceError(
      "Analytics 官方 API 返回的列定义无效。",
      "invalid-response",
      false,
    );
  }
  const rows: AnalyticsRow[] = [];
  for (const rawRow of payload.rows) {
    if (!Array.isArray(rawRow) || rawRow.length < headers.length) {
      throw new AnalyticsServiceError(
        "Analytics 官方 API 返回的行数据无效。",
        "invalid-response",
        false,
      );
    }
    const dimensions: Record<string, string> = {};
    const metrics: Partial<Record<AnalyticsMetric, number>> = {};
    headers.forEach((header, index) => {
      const name = header.name as string;
      const value = rawRow[index];
      if (header.type === "DIMENSION") {
        if (typeof value === "string") {
          dimensions[name] = value;
        }
        return;
      }
      if (typeof value === "number" && Number.isFinite(value)) {
        metrics[name as AnalyticsMetric] = value;
      } else if (
        typeof value === "string" &&
        value.trim().length > 0 &&
        Number.isFinite(Number(value))
      ) {
        metrics[name as AnalyticsMetric] = Number(value);
      }
    });
    rows.push({ dimensions, metrics });
  }
  const totalResults =
    typeof payload.totalResults === "number" &&
    Number.isInteger(payload.totalResults)
      ? payload.totalResults
      : undefined;
  const startIndex = input.startIndex ?? 1;
  const maxResults = input.maxResults ?? ANALYTICS_PAGE_SIZE;
  const nextStartIndex =
    totalResults !== undefined && startIndex + rows.length < totalResults
      ? startIndex + rows.length
      : rows.length >= maxResults
        ? startIndex + rows.length
        : undefined;
  return {
    rows,
    raw: payload,
    ...(typeof payload.dataAsOf === "string"
      ? { dataAsOf: payload.dataAsOf }
      : {}),
    ...(rows.length === 0
      ? {
          coverage: "unavailable" as const,
          reason: "官方 Analytics 在请求范围内没有可用数据。",
        }
      : { coverage: "complete" as const }),
    ...(nextStartIndex === undefined ? {} : { nextStartIndex }),
  };
}
