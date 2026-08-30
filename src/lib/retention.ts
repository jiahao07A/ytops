import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  isValidYouTubeChannelId,
  validateChannelOperationsConfig,
} from "./config.js";
import {
  classifyHttpResponseError,
  httpErrorFactoriesFor,
  RETENTION_FAILURE_KINDS,
  type RetentionFailureKind,
  RetentionServiceError,
  UserInputError,
} from "./errors.js";
import { isStale, validateMaxAgeHours } from "./freshness.js";
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

export const RETENTION_METRIC = "audienceWatchRatio";
export const RETENTION_DIMENSION = "elapsedVideoTimeRatio";
/** 官方 Analytics 可查询的最早日期，作为全历史窗口的固定起点。 */
export const RETENTION_FULL_HISTORY_START_DATE = "2005-07-14";
export const RETENTION_PAGE_SIZE = 100;

export type RetentionCoverageStatus =
  | "complete"
  | "partial"
  | "unavailable"
  | "permission-denied"
  | "estimated"
  | "delayed";

export interface RetentionPoint {
  elapsedVideoTimeRatio: number;
  audienceWatchRatio: number;
}

export interface RetentionCurveRequest {
  channelId: string;
  videoId: string;
  startDate: string;
  endDate: string;
}

export interface RetentionProviderResult {
  points: RetentionPoint[];
  raw: unknown;
  dataAsOf?: string;
  coverage?: RetentionCoverageStatus;
  reason?: string;
}

export interface RetentionProvider {
  queryCurve(
    input: RetentionCurveRequest & { accessToken: string },
  ): Promise<RetentionProviderResult>;
}

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

const REPORTS_ENDPOINT = "https://youtubeanalytics.googleapis.com/v2/reports";

export class GoogleRetentionProvider implements RetentionProvider {
  constructor(
    private readonly fetcher: Fetcher = globalThis.fetch.bind(globalThis),
  ) {}

  async queryCurve(
    input: RetentionCurveRequest & { accessToken: string },
  ): Promise<RetentionProviderResult> {
    const points: RetentionPoint[] = [];
    const pages: unknown[] = [];
    let dataAsOf: string | undefined;
    let startIndex = 1;
    for (;;) {
      const url = new URL(REPORTS_ENDPOINT);
      const params = new URLSearchParams({
        ids: `channel==${input.channelId}`,
        startDate: input.startDate,
        endDate: input.endDate,
        metrics: RETENTION_METRIC,
        dimensions: RETENTION_DIMENSION,
        filters: `video==${input.videoId}`,
        maxResults: String(RETENTION_PAGE_SIZE),
        startIndex: String(startIndex),
      });
      url.search = params.toString();

      let response: Response;
      try {
        response = await this.fetcher(url, {
          headers: { authorization: `Bearer ${input.accessToken}` },
        });
      } catch {
        throw new RetentionServiceError(
          "读取官方留存曲线时网络连接失败。",
          "network",
          true,
        );
      }
      const payload = await readJsonResponse(response);
      if (!response.ok) {
        throw classifyRetentionResponseError(response.status, payload);
      }
      const page = parseRetentionPage(payload, startIndex);
      points.push(...page.points);
      pages.push(payload);
      if (page.dataAsOf !== undefined) {
        dataAsOf = page.dataAsOf;
      }
      if (page.nextStartIndex === undefined) {
        break;
      }
      startIndex = page.nextStartIndex;
    }
    return {
      points,
      raw: pages.length === 1 ? pages[0] : pages,
      ...(dataAsOf === undefined ? {} : { dataAsOf }),
      ...(points.length === 0
        ? {
            coverage: "unavailable" as const,
            reason: "官方在该视频没有可用的留存曲线数据点。",
          }
        : { coverage: "complete" as const }),
    };
  }
}

interface RetentionPage {
  points: RetentionPoint[];
  nextStartIndex?: number;
  dataAsOf?: string;
}

function parseRetentionPage(
  payload: unknown,
  startIndex: number,
): RetentionPage {
  if (!isRecord(payload) || !Array.isArray(payload.columnHeaders)) {
    throw new RetentionServiceError(
      "官方留存曲线返回格式无效。",
      "invalid-response",
      false,
    );
  }
  const headers = payload.columnHeaders.filter(isRecord).map((header) => ({
    name: typeof header.name === "string" ? header.name : undefined,
    type: typeof header.columnType === "string" ? header.columnType : undefined,
  }));
  if (headers.some((header) => header.name === undefined)) {
    throw new RetentionServiceError(
      "官方留存曲线返回的列定义无效。",
      "invalid-response",
      false,
    );
  }
  const dimensionIndex = headers.findIndex(
    (header) =>
      header.name === RETENTION_DIMENSION && header.type === "DIMENSION",
  );
  const metricIndex = headers.findIndex(
    (header) => header.name === RETENTION_METRIC,
  );
  if (dimensionIndex < 0 || metricIndex < 0) {
    throw new RetentionServiceError(
      "官方留存曲线返回缺少留存指标或进度维度。",
      "invalid-response",
      false,
    );
  }
  // 隐私阈值可能让官方整段省略 rows 字段；此时视为该视频暂无数据点。
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const points: RetentionPoint[] = [];
  for (const rawRow of rows) {
    if (
      !Array.isArray(rawRow) ||
      rawRow.length <= Math.max(dimensionIndex, metricIndex)
    ) {
      throw new RetentionServiceError(
        "官方留存曲线返回的行数据无效。",
        "invalid-response",
        false,
      );
    }
    const ratioCell = rawRow[dimensionIndex];
    const valueCell = rawRow[metricIndex];
    const ratio =
      typeof ratioCell === "number"
        ? ratioCell
        : typeof ratioCell === "string"
          ? Number(ratioCell)
          : Number.NaN;
    const value =
      typeof valueCell === "number"
        ? valueCell
        : typeof valueCell === "string" && valueCell.trim().length > 0
          ? Number(valueCell)
          : Number.NaN;
    // 缺失任一值的单元格来自隐私阈值：省略该点，不置零。
    if (Number.isFinite(ratio) && Number.isFinite(value)) {
      points.push({
        elapsedVideoTimeRatio: ratio,
        audienceWatchRatio: value,
      });
    }
  }
  const totalResults =
    typeof payload.totalResults === "number" &&
    Number.isInteger(payload.totalResults)
      ? payload.totalResults
      : undefined;
  const nextStartIndex =
    totalResults !== undefined && startIndex + rows.length < totalResults
      ? startIndex + rows.length
      : rows.length >= RETENTION_PAGE_SIZE
        ? startIndex + rows.length
        : undefined;
  return {
    points,
    ...(nextStartIndex === undefined ? {} : { nextStartIndex }),
    ...(typeof payload.dataAsOf === "string"
      ? { dataAsOf: payload.dataAsOf }
      : {}),
  };
}

function classifyRetentionResponseError(
  status: number,
  payload: unknown,
): RetentionServiceError {
  return classifyHttpResponseError(
    status,
    payload,
    httpErrorFactoriesFor(
      (message, kind, retryable) =>
        new RetentionServiceError(message, kind, retryable),
      "Analytics ",
      { quota: "quota", network: "network" },
      () =>
        new RetentionServiceError(
          "留存曲线 OAuth 凭据无效或已过期，请重新完成授权。",
          "credential",
          false,
        ),
      () =>
        new RetentionServiceError(
          "当前 OAuth 授权不包含 Analytics 读取权限或频道不具备该资格。",
          "permission",
          false,
        ),
    ),
  ) as RetentionServiceError;
}

export type RetentionRunStatus =
  "not-started" | "running" | "partial" | "completed" | "failed";

export interface RetentionCurveRecord {
  videoId: string;
  points: RetentionPoint[];
  fetchedAt: string;
  evidencePath: string;
  coverage: RetentionCoverageStatus;
  reason?: string;
  dataAsOf?: string;
}

export interface RetentionData {
  version: 1;
  channelId: string;
  source: "youtube-analytics-api";
  startDate: string;
  endDate: string;
  curves: RetentionCurveRecord[];
  coverage: RetentionCoverageStatus;
  dataAsOf?: string;
  updatedAt?: string;
}

export interface RetentionSyncState {
  version: 1;
  channelId: string;
  status: RetentionRunStatus;
  startDate: string;
  endDate: string;
  completedVideoIds: string[];
  pendingVideoIds: string[];
  progress: { videos: number; points: number };
  coverage: RetentionCoverageStatus;
  updatedAt: string;
  startedAt?: string;
  lastSuccessAt?: string;
  dataAsOf?: string;
  error?: { kind: string; message: string; retryable: boolean };
}

export interface RetentionSyncResult {
  channelId: string;
  state: RetentionSyncState;
  data: RetentionData;
}

export interface RetentionSyncDependencies extends Pick<
  OAuthWorkflowDependencies,
  "credentialStore" | "now"
> {
  provider?: RetentionProvider;
}

interface RetentionPaths {
  root: string;
  state: string;
  data: string;
  evidence: string;
}

const coverageValues = [
  "complete",
  "partial",
  "unavailable",
  "permission-denied",
  "estimated",
  "delayed",
] as const;

const pointSchema = z
  .object({
    elapsedVideoTimeRatio: z.number().finite(),
    audienceWatchRatio: z.number().finite(),
  })
  .strict();

const curveSchema = z
  .object({
    videoId: z.string().min(1),
    points: z.array(pointSchema),
    fetchedAt: z.string().min(1),
    evidencePath: z.string().min(1),
    coverage: z.enum(coverageValues),
    reason: z.string().min(1).optional(),
    dataAsOf: z.string().min(1).optional(),
  })
  .strict();

const errorSchema = z
  .object({
    kind: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
  })
  .strict();

const retentionStateSchema = z
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
    startDate: z.string().min(1),
    endDate: z.string(),
    completedVideoIds: z.array(z.string().min(1)),
    pendingVideoIds: z.array(z.string().min(1)),
    progress: z
      .object({
        videos: z.number().int().nonnegative(),
        points: z.number().int().nonnegative(),
      })
      .strict(),
    coverage: z.enum(coverageValues),
    updatedAt: z.string().min(1),
    startedAt: z.string().min(1).optional(),
    lastSuccessAt: z.string().min(1).optional(),
    dataAsOf: z.string().min(1).optional(),
    error: errorSchema.optional(),
  })
  .strict() as unknown as z.ZodType<RetentionSyncState>;

const retentionDataSchema = z
  .object({
    version: z.literal(1),
    channelId: z.string().min(1),
    source: z.literal("youtube-analytics-api"),
    startDate: z.string().min(1),
    endDate: z.string(),
    curves: z.array(curveSchema),
    coverage: z.enum(coverageValues),
    dataAsOf: z.string().min(1).optional(),
    updatedAt: z.string().min(1).optional(),
  })
  .strict() as unknown as z.ZodType<RetentionData>;

function defaultState(channelId: string, now: string): RetentionSyncState {
  return {
    version: 1,
    channelId,
    status: "not-started",
    startDate: RETENTION_FULL_HISTORY_START_DATE,
    endDate: "",
    completedVideoIds: [],
    pendingVideoIds: [],
    progress: { videos: 0, points: 0 },
    coverage: "partial",
    updatedAt: now,
  };
}

function defaultData(state: RetentionSyncState): RetentionData {
  return {
    version: 1,
    channelId: state.channelId,
    source: "youtube-analytics-api",
    startDate: state.startDate,
    endDate: state.endDate,
    curves: [],
    coverage: "partial",
  };
}

function loadJson<T>(
  path: string,
  fallback: T,
  schema: z.ZodType<T>,
): Promise<T> {
  return loadValidatedJsonFile(path, fallback, schema, {
    corrupt: () =>
      new RetentionServiceError(
        "本机留存曲线数据文件格式无效，请保留原始证据后重新同步。",
        "invalid-response",
        false,
      ),
    unreadable: () =>
      new RetentionServiceError(
        "无法读取本机留存曲线数据文件。",
        "network",
        true,
      ),
  });
}

async function resolveRetentionPaths(
  configPath: string,
  channelId: string,
): Promise<RetentionPaths> {
  if (!isValidYouTubeChannelId(channelId)) {
    throw new UserInputError("频道 ID 必须是有效的 YouTube 频道 ID。");
  }
  const validated = await validateChannelOperationsConfig(configPath);
  const dataDirectory = resolve(
    dirname(validated.configPath),
    validated.config.global.dataDirectory,
  );
  const root = resolve(dataDirectory, "retention", channelId);
  return {
    root,
    state: resolve(root, "sync-state.json"),
    data: resolve(root, "data.json"),
    evidence: resolve(root, "evidence"),
  };
}

function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

async function saveRetentionEvidence(
  paths: RetentionPaths,
  request: RetentionCurveRequest,
  raw: unknown,
  fetchedAt: string,
): Promise<string> {
  const stamp = fetchedAt.replace(/[^0-9A-Za-z]/g, "-");
  const path = resolve(
    paths.evidence,
    `${stamp}-retention-${request.videoId}-${Date.now()}.json`,
  );
  await saveJsonFile(path, {
    source: "youtube-analytics-api",
    kind: "retention-curve",
    request: {
      channelId: request.channelId,
      videoId: request.videoId,
      startDate: request.startDate,
      endDate: request.endDate,
      metrics: [RETENTION_METRIC],
      dimensions: [RETENTION_DIMENSION],
      filters: { video: request.videoId },
    },
    fetchedAt,
    response: raw,
  });
  return path;
}

function mergedCurveCoverage(
  curves: RetentionCurveRecord[],
): RetentionCoverageStatus {
  if (curves.length === 0) {
    return "partial";
  }
  const complete = curves.filter((curve) => curve.coverage === "complete");
  const missing = curves.filter(
    (curve) =>
      curve.coverage === "unavailable" ||
      curve.coverage === "permission-denied",
  );
  if (complete.length === curves.length) {
    return "complete";
  }
  if (complete.length === 0 && missing.length === curves.length) {
    return "unavailable";
  }
  return "partial";
}

function normalizeRetentionError(error: unknown): {
  kind: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof RetentionServiceError) {
    return {
      kind: error.kind,
      message: error.message,
      retryable: error.retryable,
    };
  }
  if (error instanceof Error) {
    return { kind: "unknown", message: error.message, retryable: true };
  }
  return { kind: "unknown", message: "留存曲线同步失败。", retryable: true };
}

async function finishRetentionFailure(
  state: RetentionSyncState,
  data: RetentionData,
  paths: RetentionPaths,
  now: string,
  error: unknown,
): Promise<RetentionSyncResult> {
  const normalized = normalizeRetentionError(error);
  const nextState: RetentionSyncState = {
    ...state,
    status: data.curves.length > 0 ? "partial" : "failed",
    coverage:
      normalized.kind === "permission" ? "permission-denied" : "unavailable",
    updatedAt: now,
    error: normalized,
  };
  await saveJsonFile(paths.state, nextState);
  return { channelId: state.channelId, state: nextState, data };
}

interface RetentionRunInput {
  channelId: string;
  configPath: string;
  paths: RetentionPaths;
  state: RetentionSyncState;
  data: RetentionData;
  endDate: string;
  fetchQueue: string[];
  /** 同步任务把待处理清单当作断点续传的检查点；按需刷新不改写待处理清单。 */
  advanceBacklog: boolean;
  maxWorkUnits?: number;
  dependencies: RetentionSyncDependencies;
}

async function runRetentionFetch(
  input: RetentionRunInput,
): Promise<RetentionSyncResult> {
  const nowFactory = input.dependencies.now ?? (() => new Date());
  let access: { channelId: string; accessToken: string };
  try {
    access = await getChannelAccessToken(
      input.configPath,
      input.channelId,
      input.dependencies,
    );
  } catch (error) {
    return finishRetentionFailure(
      input.state,
      input.data,
      input.paths,
      nowFactory().toISOString(),
      error,
    );
  }

  const provider = input.dependencies.provider ?? new GoogleRetentionProvider();
  const queue = [...input.fetchQueue];
  let state = input.state;
  let data = input.data;
  let workUnits = 0;
  try {
    while (
      queue.length > 0 &&
      (input.maxWorkUnits === undefined || workUnits < input.maxWorkUnits)
    ) {
      const videoId = queue[0];
      const request: RetentionCurveRequest = {
        channelId: access.channelId,
        videoId,
        startDate: state.startDate,
        endDate: input.endDate,
      };
      const result = await provider.queryCurve({
        ...request,
        accessToken: access.accessToken,
      });
      const fetchedAt = nowFactory().toISOString();
      const evidencePath = await saveRetentionEvidence(
        input.paths,
        request,
        result.raw,
        fetchedAt,
      );
      const curve: RetentionCurveRecord = {
        videoId,
        points: result.points,
        fetchedAt,
        evidencePath,
        coverage:
          result.coverage ??
          (result.points.length > 0 ? "complete" : "unavailable"),
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        ...(result.dataAsOf === undefined ? {} : { dataAsOf: result.dataAsOf }),
      };
      const curves = [
        ...data.curves.filter((candidate) => candidate.videoId !== videoId),
        curve,
      ].sort((left, right) => left.videoId.localeCompare(right.videoId));
      const dataAsOf = result.dataAsOf ?? fetchedAt;
      data = {
        ...data,
        endDate: input.endDate,
        curves,
        coverage: mergedCurveCoverage(curves),
        dataAsOf,
        updatedAt: fetchedAt,
      };
      state = {
        ...state,
        completedVideoIds: [...new Set([...state.completedVideoIds, videoId])],
        pendingVideoIds: input.advanceBacklog
          ? queue.slice(1)
          : state.pendingVideoIds,
        progress: {
          videos: state.progress.videos + 1,
          points: state.progress.points + result.points.length,
        },
        coverage: mergedCurveCoverage(curves),
        dataAsOf,
        updatedAt: fetchedAt,
      };
      await saveJsonFile(input.paths.data, data);
      await saveJsonFile(input.paths.state, state);
      queue.shift();
      workUnits += 1;
    }

    const backlogEmpty = input.advanceBacklog
      ? queue.length === 0
      : state.pendingVideoIds.length === 0;
    const complete = queue.length === 0 && backlogEmpty;
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
              message: "本次留存曲线同步已保存检查点，可继续执行。",
              retryable: true,
            },
          }),
    };
    data = {
      ...data,
      updatedAt: completedAt,
      dataAsOf: data.dataAsOf ?? completedAt,
    };
    await saveJsonFile(input.paths.state, state);
    await saveJsonFile(input.paths.data, data);
    return { channelId: input.channelId, state, data };
  } catch (error) {
    return finishRetentionFailure(
      state,
      data,
      input.paths,
      nowFactory().toISOString(),
      error,
    );
  }
}

export async function syncRetention(
  configPath: string,
  input: {
    channelId: string;
    maxWorkUnits?: number;
  },
  dependencies: RetentionSyncDependencies = {},
): Promise<RetentionSyncResult> {
  if (
    input.maxWorkUnits !== undefined &&
    (!Number.isInteger(input.maxWorkUnits) || input.maxWorkUnits < 1)
  ) {
    throw new UserInputError("每次同步最多处理的视频数必须是正整数。");
  }
  const nowFactory = dependencies.now ?? (() => new Date());
  const paths = await resolveRetentionPaths(configPath, input.channelId);
  const now = nowFactory().toISOString();
  const previousState = await loadJson(
    paths.state,
    defaultState(input.channelId, now),
    retentionStateSchema,
  );
  const endDate = toDateOnly(nowFactory());
  const data = await loadJson(
    paths.data,
    defaultData(previousState),
    retentionDataSchema,
  );
  let state: RetentionSyncState = {
    ...previousState,
    status: "running",
    startDate: RETENTION_FULL_HISTORY_START_DATE,
    endDate,
    pendingVideoIds: [],
    updatedAt: now,
    startedAt: previousState.startedAt ?? now,
    error: undefined,
  };

  let inventoryVideoIds: string[] | undefined;
  try {
    const inventory = await getInventoryStatus(configPath, input.channelId);
    if (inventory.state.status === "completed") {
      inventoryVideoIds = [
        ...new Set(inventory.data.videos.map((video) => video.id)),
      ];
    }
  } catch {
    inventoryVideoIds = undefined;
  }
  if (inventoryVideoIds === undefined) {
    throw new RetentionServiceError(
      "尚未有可用的视频清单，请先完成频道基础数据同步。",
      "not-ready",
      true,
    );
  }

  // 断点续传检查点：上次中断的待处理视频优先，其后是本次新发现的库存视频。
  const completed = new Set(previousState.completedVideoIds);
  const fetchQueue: string[] = [];
  const queued = new Set<string>();
  for (const videoId of previousState.pendingVideoIds) {
    if (!completed.has(videoId) && !queued.has(videoId)) {
      queued.add(videoId);
      fetchQueue.push(videoId);
    }
  }
  for (const videoId of inventoryVideoIds) {
    if (!completed.has(videoId) && !queued.has(videoId)) {
      queued.add(videoId);
      fetchQueue.push(videoId);
    }
  }
  state = { ...state, pendingVideoIds: fetchQueue };
  await saveJsonFile(paths.state, state);

  return runRetentionFetch({
    channelId: input.channelId,
    configPath,
    paths,
    state,
    data,
    endDate,
    fetchQueue,
    advanceBacklog: true,
    maxWorkUnits: input.maxWorkUnits,
    dependencies,
  });
}

export async function getRetentionStatus(
  configPath: string,
  channelId: string,
): Promise<RetentionSyncResult> {
  const paths = await resolveRetentionPaths(configPath, channelId);
  let state = await loadJson(
    paths.state,
    defaultState(channelId, new Date().toISOString()),
    retentionStateSchema,
  );
  const data = await loadJson(
    paths.data,
    defaultData(state),
    retentionDataSchema,
  );
  return { channelId, state, data };
}

export type RetentionReadMode = "cached" | "refresh" | "latest";

export interface RetentionReadInput {
  channelId: string;
  videoId: string;
  mode?: RetentionReadMode;
  maxAgeHours?: number;
}

export interface RetentionReadResult {
  success: true;
  channelId: string;
  videoId: string;
  mode: RetentionReadMode;
  freshness: "fresh" | "stale";
  stale: boolean;
  dataAsOf?: string;
  lastSuccessAt?: string;
  curve: RetentionCurveRecord;
  state: RetentionSyncState;
  refresh: {
    attempted: boolean;
    status: "not-requested" | "completed" | "failed";
    error?: { kind: string; message: string; retryable: boolean };
  };
}

function curveAsOf(curve: RetentionCurveRecord): string {
  return curve.dataAsOf ?? curve.fetchedAt;
}

function isUsableCurve(curve: RetentionCurveRecord | undefined): boolean {
  return (
    curve !== undefined &&
    curve.points.length > 0 &&
    curve.coverage !== "unavailable" &&
    curve.coverage !== "permission-denied"
  );
}

function supportedRetentionKind(kind: string): RetentionFailureKind {
  return (RETENTION_FAILURE_KINDS as readonly string[]).includes(kind)
    ? (kind as RetentionFailureKind)
    : "network";
}

function failureFromState(state: RetentionSyncState): RetentionServiceError {
  const error = state.error;
  return new RetentionServiceError(
    error?.message ?? "留存曲线刷新未完成。",
    supportedRetentionKind(error?.kind ?? "network"),
    error?.retryable ?? true,
  );
}

function failureFromRun(run: RetentionSyncResult): RetentionServiceError {
  if (run.state.error !== undefined && run.state.error.kind !== "checkpoint") {
    return failureFromState(run.state);
  }
  if (run.state.coverage === "permission-denied") {
    return new RetentionServiceError(
      "当前授权没有可用的留存曲线数据。",
      "permission",
      false,
    );
  }
  return new RetentionServiceError(
    "本次留存曲线刷新没有返回可用的数据点。",
    "not-ready",
    true,
  );
}

function assembleReadResult(
  channelId: string,
  videoId: string,
  mode: RetentionReadMode,
  maxAgeHours: number,
  curve: RetentionCurveRecord,
  state: RetentionSyncState,
  now: Date,
  refresh: RetentionReadResult["refresh"],
): RetentionReadResult {
  const dataAsOf = curveAsOf(curve);
  const stale = isStale(dataAsOf, maxAgeHours, now);
  return {
    success: true,
    channelId,
    videoId,
    mode,
    freshness: stale ? "stale" : "fresh",
    stale,
    dataAsOf,
    ...(state.lastSuccessAt === undefined
      ? {}
      : { lastSuccessAt: state.lastSuccessAt }),
    curve,
    state,
    refresh,
  };
}

export async function readRetentionCurve(
  configPath: string,
  input: RetentionReadInput,
  dependencies: RetentionSyncDependencies = {},
): Promise<RetentionReadResult> {
  const videoId = input.videoId.trim();
  if (videoId.length === 0) {
    throw new UserInputError("必须提供要读取留存曲线的单个视频 ID。");
  }
  const mode = input.mode ?? "cached";
  const maxAgeHours = validateMaxAgeHours(input.maxAgeHours, {
    invalid: () =>
      new UserInputError("缓存新鲜度窗口必须在 1 到 8760 小时之间。"),
  });
  const nowFactory = dependencies.now ?? (() => new Date());
  const now = nowFactory();

  if (mode === "cached") {
    const status = await getRetentionStatus(configPath, input.channelId);
    const curve = status.data.curves.find(
      (candidate) => candidate.videoId === videoId,
    );
    if (curve !== undefined && isUsableCurve(curve)) {
      return assembleReadResult(
        input.channelId,
        videoId,
        mode,
        maxAgeHours,
        curve,
        status.state,
        now,
        { attempted: false, status: "not-requested" },
      );
    }
    if (curve !== undefined) {
      throw new RetentionServiceError(
        curve.reason ?? "官方在该视频尚无可用的留存曲线数据点。",
        "not-ready",
        true,
      );
    }
    if (status.state.status === "failed" && status.state.error !== undefined) {
      throw failureFromState(status.state);
    }
    throw new RetentionServiceError(
      "尚未有可用的留存曲线，请先执行留存同步。",
      "not-ready",
      true,
    );
  }

  // 强制最新查询 / 源站刷新：先刷新单个视频的留存曲线，再按模式决定回退。
  const paths = await resolveRetentionPaths(configPath, input.channelId);
  const previousState = await loadJson(
    paths.state,
    defaultState(input.channelId, now.toISOString()),
    retentionStateSchema,
  );
  const data = await loadJson(
    paths.data,
    defaultData(previousState),
    retentionDataSchema,
  );
  const previousCurve = data.curves.find(
    (candidate) => candidate.videoId === videoId,
  );
  const state: RetentionSyncState = {
    ...previousState,
    status: "running",
    startDate: RETENTION_FULL_HISTORY_START_DATE,
    endDate: toDateOnly(now),
    updatedAt: now.toISOString(),
  };
  const run = await runRetentionFetch({
    channelId: input.channelId,
    configPath,
    paths,
    state,
    data,
    endDate: toDateOnly(now),
    fetchQueue: [videoId],
    advanceBacklog: false,
    maxWorkUnits: 1,
    dependencies,
  });
  const curve = run.data.curves.find(
    (candidate) => candidate.videoId === videoId,
  );
  // 对象引用不等 = 本次刷新确实替换了已存的曲线（替换式合并语义）。
  const replacedCurve = curve !== undefined && curve !== previousCurve;
  if (replacedCurve && isUsableCurve(curve)) {
    return assembleReadResult(
      input.channelId,
      videoId,
      mode,
      maxAgeHours,
      curve,
      run.state,
      now,
      { attempted: true, status: "completed" },
    );
  }
  const failure = failureFromRun(run);
  if (mode === "latest") {
    throw failure;
  }
  const cached = await getRetentionStatus(configPath, input.channelId);
  const cachedCurve = cached.data.curves.find(
    (candidate) => candidate.videoId === videoId,
  );
  if (cachedCurve === undefined || !isUsableCurve(cachedCurve)) {
    throw failure;
  }
  return assembleReadResult(
    input.channelId,
    videoId,
    mode,
    maxAgeHours,
    cachedCurve,
    cached.state,
    now,
    {
      attempted: true,
      status: "failed",
      ...(run.state.error === undefined ? {} : { error: run.state.error }),
    },
  );
}
