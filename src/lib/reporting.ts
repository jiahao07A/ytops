import {
  access,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { validateChannelOperationsConfig } from "./config.js";
import { ReportingServiceError, UserInputError } from "./errors.js";
import {
  isFsCode,
  type LoadJsonFileErrors,
  isRecord,
  loadValidatedJsonFile,
  saveJsonFile,
} from "./fs-json.js";
import {
  getChannelAccessToken,
  type OAuthWorkflowDependencies,
} from "./oauth.js";

export type ReportingRunStatus =
  "requested" | "waiting" | "ready" | "imported" | "failed";
export type ReportingCoverageStatus =
  "async-processing" | "complete" | "permission-denied" | "unavailable";

export interface ReportingRow {
  [key: string]: string | number | undefined;
}

export interface ReportingProvider {
  requestReport(input: {
    accessToken: string;
    channelId: string;
    reportType: string;
    startDate?: string;
    endDate?: string;
  }): Promise<{ jobId?: string; reportId?: string; raw: unknown }>;
  getReportStatus(input: {
    accessToken: string;
    channelId: string;
    jobId?: string;
    reportId?: string;
  }): Promise<{
    status: "waiting" | "ready" | "failed";
    raw: unknown;
    reason?: string;
    downloadUrl?: string;
    dataAsOf?: string;
  }>;
  downloadReport(input: {
    accessToken: string;
    channelId: string;
    jobId?: string;
    reportId?: string;
    downloadUrl?: string;
    dataAsOf?: string;
  }): Promise<{ rows: ReportingRow[]; raw: unknown; dataAsOf?: string }>;
}

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

const REPORTING_ENDPOINT = "https://youtubereporting.googleapis.com/v1";

export class GoogleReportingProvider implements ReportingProvider {
  constructor(
    private readonly fetcher: Fetcher = globalThis.fetch.bind(globalThis),
  ) {}

  async requestReport(input: {
    accessToken: string;
    channelId: string;
    reportType: string;
    startDate?: string;
    endDate?: string;
  }): Promise<{ jobId: string; raw: unknown }> {
    const response = await this.fetcher(`${REPORTING_ENDPOINT}/jobs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        reportTypeId: input.reportType,
        ...(input.startDate === undefined
          ? {}
          : { startDate: input.startDate }),
        ...(input.endDate === undefined ? {} : { endDate: input.endDate }),
      }),
    });
    const payload = await readJson(response);
    if (!response.ok) throw classifyReportingError(response.status, payload);
    const jobId =
      isRecord(payload) && typeof payload.id === "string"
        ? payload.id
        : isRecord(payload) && typeof payload.jobId === "string"
          ? payload.jobId
          : undefined;
    if (jobId === undefined) {
      throw new ReportingServiceError(
        "Reporting 官方 API 未返回 Job ID。",
        "invalid-response",
        false,
      );
    }
    return { jobId, raw: payload };
  }

  async getReportStatus(input: {
    accessToken: string;
    channelId: string;
    jobId?: string;
    reportId?: string;
  }): Promise<{
    status: "waiting" | "ready" | "failed";
    raw: unknown;
    reason?: string;
    downloadUrl?: string;
    dataAsOf?: string;
  }> {
    const jobId = requireJobId(input);
    const response = await this.fetcher(
      `${REPORTING_ENDPOINT}/jobs/${encodeURIComponent(jobId)}/reports`,
      { headers: { authorization: `Bearer ${input.accessToken}` } },
    );
    const payload = await readJson(response);
    if (!response.ok) throw classifyReportingError(response.status, payload);
    if (!isRecord(payload) || !Array.isArray(payload.reports)) {
      throw new ReportingServiceError(
        "Reporting 官方 API 返回的报告清单格式无效。",
        "invalid-response",
        false,
      );
    }
    const first = payload.reports.find(
      (report) =>
        isRecord(report) &&
        typeof report.downloadUrl === "string" &&
        report.downloadUrl.length > 0,
    );
    if (first !== undefined && typeof first.downloadUrl === "string") {
      return {
        status: "ready",
        raw: payload,
        downloadUrl: first.downloadUrl,
        ...(typeof first.dataAsOf === "string"
          ? { dataAsOf: first.dataAsOf }
          : {}),
      };
    }
    return { status: "waiting", raw: payload };
  }

  async downloadReport(input: {
    accessToken: string;
    channelId: string;
    jobId?: string;
    reportId?: string;
    downloadUrl?: string;
    dataAsOf?: string;
  }): Promise<{ rows: ReportingRow[]; raw: unknown; dataAsOf?: string }> {
    const jobId = requireJobId(input);
    let payload: unknown = undefined;
    let first: Record<string, unknown> | undefined;
    let downloadUrl = input.downloadUrl;
    if (downloadUrl === undefined) {
      const response = await this.fetcher(
        `${REPORTING_ENDPOINT}/jobs/${encodeURIComponent(jobId)}/reports`,
        { headers: { authorization: `Bearer ${input.accessToken}` } },
      );
      payload = await readJson(response);
      if (!response.ok) throw classifyReportingError(response.status, payload);
      if (!isRecord(payload) || !Array.isArray(payload.reports)) {
        throw new ReportingServiceError(
          "Reporting 官方 API 返回的报告清单格式无效。",
          "invalid-response",
          false,
        );
      }
      first = payload.reports.find(
        (report) =>
          isRecord(report) &&
          typeof report.downloadUrl === "string" &&
          report.downloadUrl.length > 0,
      );
      downloadUrl =
        first !== undefined && typeof first.downloadUrl === "string"
          ? first.downloadUrl
          : undefined;
    }
    if (downloadUrl === undefined) {
      return { rows: [], raw: payload };
    }
    const downloadResponse = await this.fetcher(downloadUrl, {
      headers: { authorization: `Bearer ${input.accessToken}` },
    });
    if (!downloadResponse.ok) {
      throw classifyReportingError(
        downloadResponse.status,
        await readJson(downloadResponse),
      );
    }
    const text = await downloadResponse.text();
    return {
      rows: parseReportingRows(text),
      raw: { index: payload, content: text },
      ...(input.dataAsOf !== undefined
        ? { dataAsOf: input.dataAsOf }
        : first !== undefined && typeof first.dataAsOf === "string"
          ? { dataAsOf: first.dataAsOf }
          : {}),
    };
  }
}

export interface ReportingState {
  version: 1;
  channelId: string;
  /** Canonical identifier returned by jobs.create. */
  jobId?: string;
  /** Legacy alias retained for existing CLI/state consumers. */
  reportId?: string;
  reportType: string;
  status: ReportingRunStatus;
  coverage: ReportingCoverageStatus;
  requestedAt?: string;
  updatedAt: string;
  importedAt?: string;
  dataAsOf?: string;
  rowCount: number;
  error?: { kind: string; message: string; retryable: boolean };
}

export interface ReportingData {
  version: 1;
  channelId: string;
  source: "youtube-reporting-api";
  /** Canonical identifier returned by jobs.create. */
  jobId?: string;
  /** Legacy alias retained for existing CLI/state consumers. */
  reportId?: string;
  reportType: string;
  rows: ReportingRow[];
  evidence: Array<{ path: string; fetchedAt: string; phase: string }>;
  dataAsOf?: string;
}

export interface ReportingResult {
  channelId: string;
  state: ReportingState;
  data: ReportingData;
}

/** 规范化读取视图的行；reach 报表行使用 camelCase 字段，其余列如实透传。 */
export type ReportingReadRow = ReportingRow;

export interface ReportingReadResult {
  channelId: string;
  reportType: string;
  status: ReportingRunStatus;
  coverage: ReportingCoverageStatus;
  dataAsOf?: string;
  evidencePaths: string[];
  rows: ReportingReadRow[];
}

export interface ReportingDependencies extends Pick<
  OAuthWorkflowDependencies,
  "credentialStore" | "now"
> {
  provider?: ReportingProvider;
}

interface ReportingPaths {
  root: string;
  state: string;
  data: string;
  evidence: string;
}

const stateSchema = z
  .object({
    version: z.literal(1),
    channelId: z.string().min(1),
    jobId: z.string().min(1).optional(),
    reportId: z.string().min(1).optional(),
    reportType: z.string().min(1),
    status: z.enum(["requested", "waiting", "ready", "imported", "failed"]),
    coverage: z.enum([
      "async-processing",
      "complete",
      "permission-denied",
      "unavailable",
    ]),
    requestedAt: z.string().min(1).optional(),
    updatedAt: z.string().min(1),
    importedAt: z.string().min(1).optional(),
    dataAsOf: z.string().min(1).optional(),
    rowCount: z.number().int().nonnegative(),
    error: z
      .object({
        kind: z.string().min(1),
        message: z.string().min(1),
        retryable: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict() as unknown as z.ZodType<ReportingState>;

const dataSchema = z
  .object({
    version: z.literal(1),
    channelId: z.string().min(1),
    source: z.literal("youtube-reporting-api"),
    jobId: z.string().min(1).optional(),
    reportId: z.string().min(1).optional(),
    reportType: z.string().min(1),
    rows: z.array(
      z.record(z.string(), z.union([z.string(), z.number(), z.undefined()])),
    ),
    evidence: z.array(
      z
        .object({ path: z.string(), fetchedAt: z.string(), phase: z.string() })
        .strict(),
    ),
    dataAsOf: z.string().min(1).optional(),
  })
  .strict() as unknown as z.ZodType<ReportingData>;

/** 官方报告类型 ID（如 channel_basic_a2）只含这些字符，可直接作为目录名。 */
const REPORT_TYPE_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * 已登记支持的 Reporting 报表类型（官方 reportTypeId）。
 * 同步与读取校验沿用 05 号工票确立的字符集规则而非硬编码白名单：
 * 官方报表版本号（a1/a3）会随时间演进，reportTypes.list 的实时返回
 * 才是权威来源，白名单会在官方升版时把仍可用的报表拒之门外。
 */
export const REACH_REPORT_TYPE = ["channel_reach_basic_a1"] as const;

/** reach 基础报表族：官方列语义按族判断，版本号演进不改变列名。 */
const REACH_BASIC_REPORT_TYPE_PATTERN = /^channel_reach_basic_/;

/** reach 报表官方 CSV 列到规范化字段的映射；未列出的列原样保留。 */
const REACH_BASIC_COLUMN_MAP: Record<string, string> = {
  channel_id: "channelId",
  date: "date",
  video_id: "videoId",
  video_thumbnail_impressions: "impressions",
  video_thumbnail_impressions_ctr: "ctr",
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 一次性迁移：把旧的单槽位布局（reporting/<频道>/latest-*）整体搬入
 * 其报告类型目录。迁移后旧路径不再被任何读写触碰；新布局已初始化或
 * 旧报告类型不安全时保持原样，绝不覆盖新布局数据。
 */
async function migrateLegacyReportingSlot(channelRoot: string): Promise<void> {
  const legacyStatePath = resolve(channelRoot, "latest-state.json");
  const legacyDataPath = resolve(channelRoot, "latest-data.json");
  const legacyEvidencePath = resolve(channelRoot, "evidence");
  const hasLegacyState = await pathExists(legacyStatePath);
  const hasLegacyData = await pathExists(legacyDataPath);
  if (!hasLegacyState && !hasLegacyData) return;

  const keyedState = hasLegacyState
    ? await loadLegacyJson(legacyStatePath, stateSchema)
    : undefined;
  const keyedData = hasLegacyState
    ? undefined
    : await loadLegacyJson(legacyDataPath, dataSchema);
  const reportType = keyedState?.reportType ?? keyedData?.reportType;
  if (reportType === undefined || !REPORT_TYPE_PATTERN.test(reportType)) {
    return;
  }
  const targetRoot = resolve(channelRoot, reportType);
  if (await pathExists(targetRoot)) return;
  await mkdir(targetRoot, { recursive: true });

  if (hasLegacyState) {
    await rename(legacyStatePath, resolve(targetRoot, "latest-state.json"));
  }

  const legacyData =
    keyedData ?? (await tryLoadLegacyJson(legacyDataPath, dataSchema));
  if (hasLegacyData) {
    if (legacyData === undefined) {
      await rename(legacyDataPath, resolve(targetRoot, "latest-data.json"));
    } else {
      const migratedEvidence = legacyData.evidence.map((entry) => {
        const legacyPrefix = `${legacyEvidencePath}${sep}`;
        if (!entry.path.startsWith(legacyPrefix)) return entry;
        return {
          ...entry,
          path: resolve(
            targetRoot,
            "evidence",
            entry.path.slice(legacyPrefix.length),
          ),
        };
      });
      await saveJsonFile(resolve(targetRoot, "latest-data.json"), {
        ...legacyData,
        evidence: migratedEvidence,
      });
      await rm(legacyDataPath, { force: true });
    }
  }

  if (await pathExists(legacyEvidencePath)) {
    await rename(legacyEvidencePath, resolve(targetRoot, "evidence"));
  }
}

/** 迁移期读取旧文件：ENOENT 返回 undefined，损坏内容沿用既有读取错误语义。 */
function legacyJsonErrors(): LoadJsonFileErrors {
  return {
    corrupt: () =>
      new ReportingServiceError(
        "Reporting 本机状态格式无效。",
        "invalid-response",
        false,
      ),
    unreadable: () =>
      new ReportingServiceError(
        "无法读取 Reporting 本机状态。",
        "network",
        true,
      ),
  };
}

async function loadLegacyJson<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const loaded = await loadValidatedJsonFile<T | undefined>(
    path,
    undefined,
    schema,
    legacyJsonErrors(),
  );
  if (loaded === undefined) {
    // 与共享原语的 ENOENT→fallback 契约对齐：迁移路径把缺失视为不可达。
    throw legacyJsonErrors().unreadable();
  }
  return loaded;
}

async function tryLoadLegacyJson<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  try {
    return await loadLegacyJson(path, schema);
  } catch {
    return undefined;
  }
}

/** 解析频道级 Reporting 目录（运营数据仓库的 reporting/<频道>/），并完成一次性迁移。 */
async function resolveChannelReportingRoot(
  configPath: string,
  channelId: string,
): Promise<string> {
  if (!/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) {
    throw new UserInputError("频道 ID 必须是有效的 YouTube 频道 ID。");
  }
  const validated = await validateChannelOperationsConfig(configPath);
  const channelRoot = resolve(
    dirname(validated.configPath),
    validated.config.global.dataDirectory,
    "reporting",
    channelId,
  );
  await migrateLegacyReportingSlot(channelRoot);
  return channelRoot;
}

async function resolvePaths(
  configPath: string,
  channelId: string,
  reportType: string,
): Promise<ReportingPaths> {
  if (!REPORT_TYPE_PATTERN.test(reportType)) {
    throw new UserInputError(
      "Reporting 报告类型只能包含字母、数字、下划线和连字符。",
    );
  }
  const channelRoot = await resolveChannelReportingRoot(configPath, channelId);
  const root = resolve(channelRoot, reportType);
  return {
    root,
    state: resolve(root, "latest-state.json"),
    data: resolve(root, "latest-data.json"),
    evidence: resolve(root, "evidence"),
  };
}

async function load<T>(
  path: string,
  fallback: T,
  schema: z.ZodType<T>,
): Promise<T> {
  return loadValidatedJsonFile(path, fallback, schema, {
    corrupt: () =>
      new ReportingServiceError(
        "Reporting 本机状态格式无效。",
        "invalid-response",
        false,
      ),
    unreadable: () =>
      new ReportingServiceError(
        "无法读取 Reporting 本机状态。",
        "network",
        true,
      ),
  });
}

function requireJobId(input: { jobId?: string; reportId?: string }): string {
  const jobId = input.jobId ?? input.reportId;
  if (jobId === undefined || jobId.trim().length === 0) {
    throw new ReportingServiceError(
      "Reporting 操作缺少 Job ID。",
      "invalid-response",
      false,
    );
  }
  return jobId;
}

function storedJobId(value: {
  jobId?: string;
  reportId?: string;
}): string | undefined {
  return value.jobId ?? value.reportId;
}

function withCanonicalJobId<T extends { jobId?: string; reportId?: string }>(
  value: T,
): T {
  const jobId = storedJobId(value);
  return jobId === undefined || value.jobId !== undefined
    ? value
    : { ...value, jobId };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function classifyReportingError(
  status: number,
  payload: unknown,
): ReportingServiceError {
  const message =
    isRecord(payload) &&
    isRecord(payload.error) &&
    typeof payload.error.message === "string"
      ? payload.error.message
      : "Reporting 官方 API 请求失败。";
  if (status === 401)
    return new ReportingServiceError(
      "Reporting OAuth 凭据无效或已过期。",
      "credential",
      false,
    );
  if (status === 403)
    return new ReportingServiceError(message, "permission", false);
  if (status === 429)
    return new ReportingServiceError(
      "Reporting 官方 API 配额不足。",
      "quota",
      true,
    );
  if (status >= 500) return new ReportingServiceError(message, "network", true);
  return new ReportingServiceError(message, "network", false);
}

function parseReportingRows(text: string): ReportingRow[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(
      headers.map((header, index) => [header, values[index] ?? ""]),
    );
  });
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  values.push(current);
  return values;
}

function emptyState(
  channelId: string,
  reportType: string,
  now: string,
): ReportingState {
  return {
    version: 1,
    channelId,
    reportType,
    status: "waiting",
    coverage: "async-processing",
    updatedAt: now,
    rowCount: 0,
  };
}

function emptyData(channelId: string, reportType: string): ReportingData {
  return {
    version: 1,
    channelId,
    source: "youtube-reporting-api",
    reportType,
    rows: [],
    evidence: [],
  };
}

function rowKey(row: ReportingRow): string {
  return JSON.stringify(
    Object.entries(row).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function normalizeError(error: unknown): {
  kind: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof ReportingServiceError)
    return {
      kind: error.kind,
      message: error.message,
      retryable: error.retryable,
    };
  if (error instanceof Error)
    return { kind: "network", message: error.message, retryable: true };
  return { kind: "network", message: "Reporting 同步失败。", retryable: true };
}

export async function getReportingStatus(
  configPath: string,
  channelId: string,
  options: { reportType: string },
): Promise<ReportingResult> {
  const paths = await resolvePaths(configPath, channelId, options.reportType);
  const state = withCanonicalJobId(
    await load(
      paths.state,
      emptyState(channelId, options.reportType, new Date().toISOString()),
      stateSchema,
    ),
  );
  const data = await load(
    paths.data,
    emptyData(channelId, state.reportType),
    dataSchema,
  );
  return { channelId, state, data: withCanonicalJobId(data) };
}

/** reach 报表行按官方列映射规范化；其余报表类型的行原样透传。 */
function normalizeReportingRow(
  reportType: string,
  row: ReportingRow,
): ReportingReadRow {
  if (!REACH_BASIC_REPORT_TYPE_PATTERN.test(reportType)) {
    return { ...row };
  }
  const normalized: ReportingReadRow = {};
  for (const [column, value] of Object.entries(row)) {
    normalized[REACH_BASIC_COLUMN_MAP[column] ?? column] = value;
  }
  return normalized;
}

/**
 * 读取已导入 Reporting 报表行的规范化视图，可按视频过滤。
 * reach 报表行的曝光与点击率取 CSV 原值（小数或百分数均不换算）。
 */
export async function readReportingRows(
  configPath: string,
  channelId: string,
  options: { reportType: string; videoId?: string },
): Promise<ReportingReadResult> {
  if (options.videoId !== undefined && options.videoId.trim().length === 0) {
    throw new UserInputError("视频 ID 不能为空。");
  }
  const { state, data } = await getReportingStatus(configPath, channelId, {
    reportType: options.reportType,
  });
  const rows = data.rows
    .map((row) => normalizeReportingRow(state.reportType, row))
    .filter(
      (row) =>
        options.videoId === undefined ||
        (row.videoId ?? row.video_id) === options.videoId,
    );
  return {
    channelId,
    reportType: state.reportType,
    status: state.status,
    coverage: state.coverage,
    ...(data.dataAsOf === undefined && state.dataAsOf === undefined
      ? {}
      : { dataAsOf: data.dataAsOf ?? state.dataAsOf }),
    evidencePaths: data.evidence.map((entry) => entry.path),
    rows,
  };
}

/**
 * 列出频道下全部已有状态的报告类型（按报告类型名称稳定排序）。
 * 只呈现真正同步过的报告类型目录，不为缺失类型虚构默认状态。
 */ export async function listReportingResults(
  configPath: string,
  channelId: string,
): Promise<ReportingResult[]> {
  const channelRoot = await resolveChannelReportingRoot(configPath, channelId);
  let entries: Dirent[];
  try {
    entries = await readdir(channelRoot, { withFileTypes: true });
  } catch (error) {
    if (isFsCode(error, "ENOENT")) {
      return [];
    }
    throw new ReportingServiceError(
      "无法读取 Reporting 本机状态。",
      "network",
      true,
    );
  }
  const results: ReportingResult[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const typeRoot = resolve(channelRoot, entry.name);
    const statePath = resolve(typeRoot, "latest-state.json");
    if (!(await pathExists(statePath))) continue;
    const state = withCanonicalJobId(
      await load(
        statePath,
        emptyState(channelId, entry.name, new Date().toISOString()),
        stateSchema,
      ),
    );
    const data = withCanonicalJobId(
      await load(
        resolve(typeRoot, "latest-data.json"),
        emptyData(channelId, state.reportType),
        dataSchema,
      ),
    );
    results.push({ channelId, state, data });
  }
  return results.sort((left, right) =>
    left.state.reportType.localeCompare(right.state.reportType),
  );
}

export async function syncReporting(
  configPath: string,
  input: {
    channelId: string;
    reportType: string;
    jobId?: string;
    /** Legacy CLI option; treated as a Job ID. */
    reportId?: string;
  },
  dependencies: ReportingDependencies = {},
): Promise<ReportingResult> {
  if (input.reportType.trim().length === 0)
    throw new UserInputError("必须提供 Reporting 报告类型。");
  const nowFactory = dependencies.now ?? (() => new Date());
  const paths = await resolvePaths(
    configPath,
    input.channelId,
    input.reportType,
  );
  let state = withCanonicalJobId(
    await load(
      paths.state,
      emptyState(input.channelId, input.reportType, nowFactory().toISOString()),
      stateSchema,
    ),
  );
  let data = withCanonicalJobId(
    await load(
      paths.data,
      emptyData(input.channelId, input.reportType),
      dataSchema,
    ),
  );
  const provider = dependencies.provider;
  if (provider === undefined) {
    throw new ReportingServiceError(
      "未配置 Reporting 官方适配器。",
      "not-ready",
      false,
    );
  }
  const explicitJobId = input.jobId ?? input.reportId;
  if (
    (explicitJobId === undefined || explicitJobId === storedJobId(state)) &&
    state.status === "imported" &&
    state.reportType === input.reportType &&
    storedJobId(state) !== undefined &&
    data.reportType === input.reportType &&
    data.rows.length === state.rowCount
  ) {
    return { channelId: input.channelId, state, data };
  }
  try {
    const access = await getChannelAccessToken(
      configPath,
      input.channelId,
      dependencies,
    );
    let jobId = explicitJobId ?? storedJobId(state);
    if (jobId === undefined) {
      const requested = await provider.requestReport({
        accessToken: access.accessToken,
        channelId: access.channelId,
        reportType: input.reportType,
      });
      jobId = requested.jobId ?? requested.reportId;
      if (jobId === undefined) {
        throw new ReportingServiceError(
          "Reporting 官方 API 未返回 Job ID。",
          "invalid-response",
          false,
        );
      }
      const requestedAt = nowFactory().toISOString();
      state = {
        ...state,
        jobId,
        reportId: jobId,
        reportType: input.reportType,
        status: "requested",
        coverage: "async-processing",
        requestedAt,
        updatedAt: requestedAt,
        error: undefined,
      };
      const evidencePath = resolve(
        paths.evidence,
        `${requestedAt.replace(/[^0-9A-Za-z]/g, "-")}-request.json`,
      );
      await saveJsonFile(evidencePath, {
        source: "youtube-reporting-api",
        phase: "request",
        reportType: input.reportType,
        fetchedAt: requestedAt,
        response: requested.raw,
      });
      data = {
        ...data,
        jobId,
        reportId: jobId,
        reportType: input.reportType,
        evidence: [
          ...data.evidence,
          { path: evidencePath, fetchedAt: requestedAt, phase: "request" },
        ],
      };
      await saveJsonFile(paths.state, state);
      await saveJsonFile(paths.data, data);
    }
    if (jobId === undefined) {
      throw new ReportingServiceError(
        "Reporting 操作缺少 Job ID。",
        "invalid-response",
        false,
      );
    }
    const reportStatus = await provider.getReportStatus({
      accessToken: access.accessToken,
      channelId: access.channelId,
      jobId,
      reportId: jobId,
    });
    const checkedAt = nowFactory().toISOString();
    if (reportStatus.status === "waiting") {
      state = {
        ...state,
        jobId,
        reportId: jobId,
        status: "waiting",
        coverage: "async-processing",
        updatedAt: checkedAt,
      };
      await saveJsonFile(paths.state, state);
      return { channelId: input.channelId, state, data };
    }
    if (reportStatus.status === "failed") {
      const error = {
        kind: "not-ready",
        message: reportStatus.reason ?? "Reporting 报告不可用。",
        retryable: true,
      };
      state = {
        ...state,
        jobId,
        reportId: jobId,
        status: "failed",
        coverage: "unavailable",
        updatedAt: checkedAt,
        error,
      };
      await saveJsonFile(paths.state, state);
      return { channelId: input.channelId, state, data };
    }
    state = {
      ...state,
      jobId,
      reportId: jobId,
      status: "ready",
      coverage: "async-processing",
      updatedAt: checkedAt,
    };
    await saveJsonFile(paths.state, state);
    const downloaded = await provider.downloadReport({
      accessToken: access.accessToken,
      channelId: access.channelId,
      jobId,
      reportId: jobId,
      downloadUrl: reportStatus.downloadUrl,
      dataAsOf: reportStatus.dataAsOf,
    });
    const evidencePath = resolve(
      paths.evidence,
      `${checkedAt.replace(/[^0-9A-Za-z]/g, "-")}-import.json`,
    );
    await saveJsonFile(evidencePath, {
      source: "youtube-reporting-api",
      phase: "import",
      jobId,
      reportId: jobId,
      fetchedAt: checkedAt,
      response: downloaded.raw,
    });
    const rowsByKey = new Map(data.rows.map((row) => [rowKey(row), row]));
    for (const row of downloaded.rows) rowsByKey.set(rowKey(row), row);
    const rows = [...rowsByKey.values()];
    data = {
      ...data,
      jobId,
      reportId: jobId,
      reportType: input.reportType,
      rows,
      dataAsOf: downloaded.dataAsOf ?? checkedAt,
      evidence: [
        ...data.evidence,
        { path: evidencePath, fetchedAt: checkedAt, phase: "import" },
      ],
    };
    state = {
      ...state,
      jobId,
      reportId: jobId,
      reportType: input.reportType,
      status: "imported",
      coverage: "complete",
      updatedAt: checkedAt,
      importedAt: checkedAt,
      dataAsOf: data.dataAsOf,
      rowCount: rows.length,
      error: undefined,
    };
    await saveJsonFile(paths.data, data);
    await saveJsonFile(paths.state, state);
    return { channelId: input.channelId, state, data };
  } catch (error) {
    const normalized = normalizeError(error);
    state = {
      ...state,
      status: "failed",
      coverage:
        normalized.kind === "permission" ? "permission-denied" : "unavailable",
      updatedAt: nowFactory().toISOString(),
      error: normalized,
    };
    await saveJsonFile(paths.state, state);
    return { channelId: input.channelId, state, data };
  }
}
