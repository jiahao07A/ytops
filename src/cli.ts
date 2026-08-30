#!/usr/bin/env node
import { stat } from "node:fs/promises";
import { Command, CommanderError } from "commander";
import { z } from "zod";
import {
  type AnalysisProfileOverrides,
  type ChannelConfigOverrides,
  type ChannelOperationsConfigOverrides,
  type GlobalConfigOverrides,
  assertSupportedAnalysisFilter,
  assertSafeFreeformConfigurationKey,
  explainChannelOperationsConfig,
  initializeChannelOperationsConfig,
  isSupportedCookieBrowserSpec,
  redactConfigurationPathForOutput,
  updateAnalysisProfileOperationsConfig,
  updateChannelOperationsConfig,
  updateGlobalChannelOperationsConfig,
  validateChannelOperationsConfig,
} from "./lib/config.js";
import { runDoctor } from "./lib/doctor.js";
import {
  AnalyticsServiceError,
  ExternalCommandError,
  InventoryServiceError,
  OAuthServiceError,
  CommentsServiceError,
  ReportingServiceError,
  RetentionServiceError,
  UserInputError,
} from "./lib/errors.js";
import {
  externalToolErrorCode,
  inventorySyncFailure,
  schedulerRunFailure,
  oauthRefreshFailure,
  type CliFailure,
} from "./lib/cli-contract.js";
import { ExternalToolError } from "./lib/process.js";
import { clipMedia, extractAudio, probeMedia } from "./lib/media.js";
import {
  type CookieSettings,
  downloadMedia,
  fetchCaptions,
  inspectVideo,
  listCaptionLanguages,
  normalizeQuality,
  searchVideos,
} from "./lib/yt-dlp.js";
import {
  beginChannelOAuth,
  completeChannelOAuth,
  getChannelConnectionStatus,
  GoogleOAuthProvider,
  OAuthTokenRefreshError,
  selectChannelConnection,
  YOUTUBE_ANALYTICS_READONLY_SCOPE,
  YOUTUBE_FORCE_SSL_SCOPE,
} from "./lib/oauth.js";
import {
  getInventoryStatus,
  GoogleInventoryProvider,
  parseInventoryScope,
  syncInventory,
} from "./lib/inventory.js";
import {
  getAnalyticsStatus,
  GoogleAnalyticsProvider,
  queryAnalytics,
  syncAnalytics,
} from "./lib/analytics.js";
import { readAnalyticsFacts } from "./lib/freshness.js";
import {
  getRetentionStatus,
  GoogleRetentionProvider,
  readRetentionCurve,
  syncRetention,
} from "./lib/retention.js";
import {
  queryBreakdown,
  readBreakdownResult,
  saveBreakdownProfile,
} from "./lib/breakdowns.js";
import {
  getReportingStatus,
  GoogleReportingProvider,
  listReportingResults,
  syncReporting,
} from "./lib/reporting.js";
import {
  getCommentsStatus,
  GoogleCommentsProvider,
  syncComments,
} from "./lib/comments.js";
import { getCoverageMatrix } from "./lib/coverage.js";
import { runDueInventoryTasks } from "./lib/scheduler.js";
import {
  disableTaskScheduler,
  getTaskSchedulerStatus,
  installTaskScheduler,
} from "./lib/task-scheduler.js";

interface GlobalOptions {
  json?: boolean;
}

interface ErrorPayload {
  ok: false;
  error: CliFailure;
}

const program = new Command();
let jsonCommanderOutput = "";

program
  .configureOutput({
    writeOut: (message) => {
      if (wantsJson()) {
        jsonCommanderOutput += message;
      } else {
        process.stdout.write(message);
      }
    },
    writeErr: (message) => {
      if (!wantsJson()) {
        process.stderr.write(message);
      }
    },
  })
  .exitOverride();

program
  .name("ytops")
  .description("安全、可脚本化的 YouTube 研究、媒体处理与运营辅助 CLI")
  .version("0.1.0")
  .option("--json", "输出稳定的 JSON，适合 skills、脚本和 MCP 适配层调用");

function wantsJson(): boolean {
  return (
    process.argv.slice(2).includes("--json") ||
    Boolean((program.opts() as GlobalOptions).json)
  );
}

function emit(value: unknown, title: string): void {
  if (wantsJson()) {
    console.log(JSON.stringify({ ok: true, data: value }, null, 2));
    return;
  }

  console.log(title);
  console.log(JSON.stringify(value, null, 2));
}

function redactConfigCommandResult<T extends { configPath: string }>(
  result: T,
): T {
  return {
    ...result,
    configPath: redactConfigurationPathForOutput(result.configPath),
  };
}

function parseInteger(
  value: string,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = z.coerce
    .number()
    .int()
    .min(minimum)
    .max(maximum)
    .safeParse(value);
  if (!parsed.success) {
    throw new UserInputError(
      `${name} 必须是 ${minimum} 到 ${maximum} 之间的整数。`,
    );
  }
  return parsed.data;
}

interface GlobalConfigOverrideOptions {
  dataDirectory?: string;
  syncFrequencyHours?: string;
  maxConcurrency?: string;
  quotaBudget?: string;
  initialBackfillDays?: string;
  cookiesFile?: string;
  cookiesFromBrowser?: string;
  rawEvidenceRetentionDays?: string;
}

interface ChannelConfigOverrideOptions {
  channel?: string;
  channelEnabled?: string;
  channelSyncFrequencyHours?: string;
  channelMaxConcurrency?: string;
  channelQuotaBudget?: string;
  channelInitialBackfillDays?: string;
  channelRawEvidenceRetentionDays?: string;
}

interface AnalysisProfileOverrideOptions {
  profile?: string;
  profileMetrics?: string;
  profileDimensions?: string;
  profileDateRange?: string;
  profileFilter?: string[];
}

type ConfigCommandOptions = GlobalConfigOverrideOptions &
  ChannelConfigOverrideOptions &
  AnalysisProfileOverrideOptions & {
    config: string;
  };

function parseGlobalCookieOverrides(
  options: GlobalConfigOverrideOptions,
): GlobalConfigOverrides["cookies"] {
  if (
    options.cookiesFile === undefined &&
    options.cookiesFromBrowser === undefined
  ) {
    return undefined;
  }
  if (
    options.cookiesFile !== undefined &&
    options.cookiesFromBrowser !== undefined
  ) {
    throw new UserInputError(
      "--cookies-file 与 --cookies-from-browser 只能提供其中一个。",
    );
  }

  const cookiesFile = options.cookiesFile?.trim();
  if (cookiesFile !== undefined) {
    if (cookiesFile.length === 0) {
      return null;
    }
    return { file: cookiesFile };
  }

  const cookiesFromBrowser = options.cookiesFromBrowser?.trim();
  if (cookiesFromBrowser !== undefined) {
    if (cookiesFromBrowser.length === 0) {
      return null;
    }
    return { fromBrowser: cookiesFromBrowser };
  }

  return undefined;
}

function parseGlobalConfigOverrides(
  options: GlobalConfigOverrideOptions,
): GlobalConfigOverrides {
  const cookieOverrides = parseGlobalCookieOverrides(options);
  return {
    dataDirectory: options.dataDirectory,
    sync: {
      ...(options.syncFrequencyHours === undefined
        ? {}
        : {
            frequencyHours: parseInteger(
              options.syncFrequencyHours,
              "--sync-frequency-hours",
              1,
              168,
            ),
          }),
      ...(options.maxConcurrency === undefined
        ? {}
        : {
            maxConcurrency: parseInteger(
              options.maxConcurrency,
              "--max-concurrency",
              1,
              16,
            ),
          }),
      ...(options.quotaBudget === undefined
        ? {}
        : {
            quotaBudget: parseInteger(
              options.quotaBudget,
              "--quota-budget",
              1,
              1_000_000,
            ),
          }),
      ...(options.initialBackfillDays === undefined
        ? {}
        : {
            initialBackfillDays: parseInteger(
              options.initialBackfillDays,
              "--initial-backfill-days",
              1,
              3_650,
            ),
          }),
    },
    ...(options.rawEvidenceRetentionDays === undefined
      ? {}
      : {
          rawEvidenceRetentionDays: parseInteger(
            options.rawEvidenceRetentionDays,
            "--raw-evidence-retention-days",
            1,
            3_650,
          ),
        }),
    ...(cookieOverrides === undefined ? {} : { cookies: cookieOverrides }),
  };
}

function parseBoolean(value: string, name: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  throw new UserInputError(`${name} 必须是 true 或 false。`);
}

interface PublicCookieOptions {
  cookies?: string;
  cookiesFromBrowser?: string;
  config?: string;
}

function addPublicRetrievalOptions(command: Command): Command {
  return command
    .option(
      "--cookies <file>",
      "显式提供 Netscape cookie 文件；与 --cookies-from-browser 互斥",
    )
    .option(
      "--cookies-from-browser <spec>",
      "让 yt-dlp 从指定浏览器读取 cookie；Windows 上 Chrome/Edge 受 App-Bound Encryption 限制，推荐 firefox",
    )
    .option(
      "-c, --config <path>",
      "读取运营配置 global.cookies 作为默认 cookie 来源",
    );
}

function assertSupportedCookieBrowserOption(spec: string): void {
  if (!isSupportedCookieBrowserSpec(spec)) {
    throw new UserInputError(
      "--cookies-from-browser 只支持 brave、chrome、chromium、edge、firefox、opera、safari、vivaldi、whale，可原样附加 yt-dlp 的 keyring、profile 或 container 后缀。",
    );
  }
}

async function assertCookieFileAvailable(path: string): Promise<void> {
  let fileStats;
  try {
    fileStats = await stat(path);
  } catch {
    throw new UserInputError(`cookie 文件不存在或无法访问：${path}`);
  }
  if (!fileStats.isFile()) {
    throw new UserInputError(`cookie 文件路径必须指向文件而不是目录：${path}`);
  }
}

async function resolvePublicCookieSettings(
  options: PublicCookieOptions,
): Promise<CookieSettings | undefined> {
  if (
    options.cookies !== undefined &&
    options.cookiesFromBrowser !== undefined
  ) {
    throw new UserInputError(
      "--cookies 与 --cookies-from-browser 只能提供其中一个。",
    );
  }

  if (options.cookies !== undefined && options.cookies.trim().length === 0) {
    throw new UserInputError("--cookies 不能为空。");
  }
  if (
    options.cookiesFromBrowser !== undefined &&
    options.cookiesFromBrowser.trim().length === 0
  ) {
    throw new UserInputError("--cookies-from-browser 不能为空。");
  }

  let file = options.cookies?.trim();
  let fromBrowser = options.cookiesFromBrowser?.trim();
  let fileSource =
    options.cookies !== undefined ? "命令行 --cookies" : undefined;
  let browserSource =
    options.cookiesFromBrowser !== undefined
      ? "命令行 --cookies-from-browser"
      : undefined;

  const environmentFile = process.env.YTOPS_YTDLP_COOKIES_FILE?.trim();
  if (file === undefined && environmentFile) {
    file = environmentFile;
    fileSource = "环境变量 YTOPS_YTDLP_COOKIES_FILE";
  }
  const environmentBrowser =
    process.env.YTOPS_YTDLP_COOKIES_FROM_BROWSER?.trim();
  if (fromBrowser === undefined && environmentBrowser) {
    fromBrowser = environmentBrowser;
    browserSource = "环境变量 YTOPS_YTDLP_COOKIES_FROM_BROWSER";
  }

  if (
    options.config !== undefined &&
    (file === undefined || fromBrowser === undefined)
  ) {
    const { config } = await validateChannelOperationsConfig(options.config);
    const configuredCookies = config.global.cookies;
    if (file === undefined && configuredCookies?.file !== undefined) {
      file = configuredCookies.file;
      fileSource = "配置文件 global.cookies.file";
    }
    if (
      fromBrowser === undefined &&
      configuredCookies?.fromBrowser !== undefined
    ) {
      fromBrowser = configuredCookies.fromBrowser;
      browserSource = "配置文件 global.cookies.fromBrowser";
    }
  }

  if (file !== undefined && fromBrowser !== undefined) {
    throw new UserInputError(
      `${fileSource}与${browserSource}同时提供；一次只能使用一种 cookie 来源。`,
    );
  }
  if (file !== undefined) {
    await assertCookieFileAvailable(file);
    return { file };
  }
  if (fromBrowser !== undefined) {
    assertSupportedCookieBrowserOption(fromBrowser);
    return { fromBrowser };
  }
  return undefined;
}

function parseCommaSeparatedList(value: string, name: string): string[] {
  const items = value.split(",").map((item) => item.trim());
  if (items.length === 0 || items.some((item) => item.length === 0)) {
    throw new UserInputError(
      `${name} 必须是至少包含一个非空值的逗号分隔列表。`,
    );
  }
  return items;
}

function collectOptionValue(
  value: string,
  previous: string[] | undefined,
): string[] {
  return [...(previous ?? []), value];
}

function parseProfileFilters(
  values: string[] | undefined,
): Record<string, string> | undefined {
  if (values === undefined) {
    return undefined;
  }

  const filters: Record<string, string> = {};
  for (const value of values) {
    const separatorIndex = value.indexOf("=");
    if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
      throw new UserInputError(
        "--profile-filter 必须使用 field=value 格式，且字段和值都不能为空。",
      );
    }

    const field = value.slice(0, separatorIndex).trim();
    const filterValue = value.slice(separatorIndex + 1).trim();
    if (field.length === 0 || filterValue.length === 0) {
      throw new UserInputError(
        "--profile-filter 必须使用 field=value 格式，且字段和值都不能为空。",
      );
    }
    assertSafeFreeformConfigurationKey(field, "分析配置档案的筛选字段");
    assertSupportedAnalysisFilter(field, filterValue);
    if (Object.hasOwn(filters, field)) {
      throw new UserInputError("同一筛选字段只能提供一次。请合并后重试。");
    }
    filters[field] = filterValue;
  }

  return filters;
}

function parseChannelConfigOverrides(
  options: ChannelConfigOverrideOptions,
): ChannelConfigOverrides | undefined {
  const hasChannelOptions =
    options.channelEnabled !== undefined ||
    options.channelSyncFrequencyHours !== undefined ||
    options.channelMaxConcurrency !== undefined ||
    options.channelQuotaBudget !== undefined ||
    options.channelInitialBackfillDays !== undefined ||
    options.channelRawEvidenceRetentionDays !== undefined;

  if (options.channel === undefined) {
    if (hasChannelOptions) {
      throw new UserInputError(
        "使用频道层配置覆盖时，必须同时提供 --channel <channel-id>。",
      );
    }
    return undefined;
  }

  const sync: NonNullable<ChannelConfigOverrides["sync"]> = {
    ...(options.channelSyncFrequencyHours === undefined
      ? {}
      : {
          frequencyHours: parseInteger(
            options.channelSyncFrequencyHours,
            "--channel-sync-frequency-hours",
            1,
            168,
          ),
        }),
    ...(options.channelMaxConcurrency === undefined
      ? {}
      : {
          maxConcurrency: parseInteger(
            options.channelMaxConcurrency,
            "--channel-max-concurrency",
            1,
            16,
          ),
        }),
    ...(options.channelQuotaBudget === undefined
      ? {}
      : {
          quotaBudget: parseInteger(
            options.channelQuotaBudget,
            "--channel-quota-budget",
            1,
            1_000_000,
          ),
        }),
    ...(options.channelInitialBackfillDays === undefined
      ? {}
      : {
          initialBackfillDays: parseInteger(
            options.channelInitialBackfillDays,
            "--channel-initial-backfill-days",
            1,
            3_650,
          ),
        }),
  };

  return {
    channelId: options.channel,
    ...(options.channelEnabled === undefined
      ? {}
      : {
          enabled: parseBoolean(options.channelEnabled, "--channel-enabled"),
        }),
    ...(Object.keys(sync).length === 0 ? {} : { sync }),
    ...(options.channelRawEvidenceRetentionDays === undefined
      ? {}
      : {
          rawEvidenceRetentionDays: parseInteger(
            options.channelRawEvidenceRetentionDays,
            "--channel-raw-evidence-retention-days",
            1,
            3_650,
          ),
        }),
  };
}

function parseAnalysisProfileOverrides(
  options: AnalysisProfileOverrideOptions,
): AnalysisProfileOverrides | undefined {
  const hasProfileOptions =
    options.profileMetrics !== undefined ||
    options.profileDimensions !== undefined ||
    options.profileDateRange !== undefined ||
    options.profileFilter !== undefined;

  if (options.profile === undefined) {
    if (hasProfileOptions) {
      throw new UserInputError(
        "使用分析档案层配置覆盖时，必须同时提供 --profile <name>。",
      );
    }
    return undefined;
  }

  assertSafeFreeformConfigurationKey(options.profile, "分析配置档案名称");
  return {
    name: options.profile,
    ...(options.profileMetrics === undefined
      ? {}
      : {
          metrics: parseCommaSeparatedList(
            options.profileMetrics,
            "--profile-metrics",
          ),
        }),
    ...(options.profileDimensions === undefined
      ? {}
      : {
          dimensions: parseCommaSeparatedList(
            options.profileDimensions,
            "--profile-dimensions",
          ),
        }),
    ...(options.profileDateRange === undefined
      ? {}
      : { dateRange: options.profileDateRange }),
    ...(options.profileFilter === undefined
      ? {}
      : { filters: parseProfileFilters(options.profileFilter) }),
  };
}

function parseChannelOperationsConfigOverrides(
  options: GlobalConfigOverrideOptions &
    ChannelConfigOverrideOptions &
    AnalysisProfileOverrideOptions,
): ChannelOperationsConfigOverrides {
  const channel = parseChannelConfigOverrides(options);
  const analysisProfile = parseAnalysisProfileOverrides(options);

  return {
    global: parseGlobalConfigOverrides(options),
    ...(channel === undefined ? {} : { channel }),
    ...(analysisProfile === undefined ? {} : { analysisProfile }),
  };
}

function requireChannelConfigOverrides(
  options: ChannelConfigOverrideOptions,
): ChannelConfigOverrides {
  const overrides = parseChannelConfigOverrides(options);
  if (overrides === undefined) {
    throw new UserInputError("必须提供 --channel <channel-id>。");
  }
  return overrides;
}

function requireAnalysisProfileOverrides(
  options: AnalysisProfileOverrideOptions,
): AnalysisProfileOverrides {
  const overrides = parseAnalysisProfileOverrides(options);
  if (overrides === undefined) {
    throw new UserInputError("必须提供 --profile <name>。");
  }
  return overrides;
}

function requireRightsConfirmation(confirmed: boolean): void {
  if (!confirmed) {
    throw new UserInputError(
      "下载会写入媒体文件。请确认你拥有内容权利或已获授权后，重新添加 --rights-confirmed。",
    );
  }
}

function safeErrorMessage(message: string): string {
  return redactConfigurationPathForOutput(message) === message
    ? message
    : "操作失败。为保护凭据，敏感路径已隐藏。";
}

function readableError(error: unknown): ErrorPayload["error"] {
  if (error instanceof CommanderError) {
    return {
      code: error.code,
      message: safeErrorMessage(error.message.trim()),
    };
  }
  if (error instanceof UserInputError) {
    return { code: error.code, message: safeErrorMessage(error.message) };
  }
  if (error instanceof ExternalToolError) {
    return {
      code: externalToolErrorCode(error.kind),
      message: safeErrorMessage(error.message),
      details: safeErrorMessage(error.stderr || "外部工具没有返回可读错误。"),
    };
  }
  if (error instanceof ExternalCommandError) {
    return {
      code: error.code,
      message: safeErrorMessage(error.message),
      details: safeErrorMessage(error.stderr || "外部工具没有返回可读错误。"),
    };
  }
  if (error instanceof OAuthTokenRefreshError) {
    const failure = oauthRefreshFailure(error);
    return {
      ...failure,
      message: safeErrorMessage(failure.message),
    };
  }
  if (error instanceof OAuthServiceError) {
    return { code: error.code, message: safeErrorMessage(error.message) };
  }
  if (error instanceof InventoryServiceError) {
    return {
      code: error.code,
      message: safeErrorMessage(error.message),
      details: `类别：${error.kind}；可重试：${error.retryable ? "是" : "否"}`,
    };
  }
  if (error instanceof AnalyticsServiceError) {
    return {
      code: error.code,
      message: safeErrorMessage(error.message),
      details: `类别：${error.kind}；可重试：${error.retryable ? "是" : "否"}`,
    };
  }
  if (error instanceof ReportingServiceError) {
    return {
      code: error.code,
      message: safeErrorMessage(error.message),
      details: `类别：${error.kind}；可重试：${error.retryable ? "是" : "否"}`,
    };
  }
  if (error instanceof CommentsServiceError) {
    return {
      code: error.code,
      message: safeErrorMessage(error.message),
      details: `类别：${error.kind}；可重试：${error.retryable ? "是" : "否"}`,
    };
  }
  if (error instanceof RetentionServiceError) {
    return {
      code: error.code,
      message: safeErrorMessage(error.message),
      details: `类别：${error.kind}；可重试：${error.retryable ? "是" : "否"}`,
    };
  }
  if (error instanceof Error) {
    return { code: "UNEXPECTED", message: safeErrorMessage(error.message) };
  }
  return { code: "UNEXPECTED", message: "发生未知错误。" };
}

function emitError(error: ErrorPayload["error"]): void {
  const payload: ErrorPayload = { ok: false, error };
  if (wantsJson()) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.error(`错误：${payload.error.message}`);
    if (payload.error.details !== undefined) {
      console.error(
        typeof payload.error.details === "string"
          ? payload.error.details
          : JSON.stringify(payload.error.details, null, 2),
      );
    }
  }
  process.exitCode = 1;
}

async function execute<T>(
  title: string,
  task: () => Promise<T>,
  classifyResult?: (result: T) => CliFailure | undefined,
): Promise<void> {
  try {
    const result = await task();
    const failure = classifyResult?.(result);
    if (failure !== undefined) {
      emitError(failure);
      return;
    }
    emit(result, title);
  } catch (error) {
    emitError(readableError(error));
  }
}

program
  .command("doctor")
  .description("检查 yt-dlp、FFmpeg 与可选运营工具是否可用")
  .action(async () => execute("环境检查", runDoctor));

const config = program
  .command("config")
  .description("初始化和检查频道运营数据配置");

function addGlobalConfigOverrideOptions(command: Command): Command {
  return command
    .option("--data-directory <path>", "更新本机数据目录")
    .option("--sync-frequency-hours <hours>", "更新同步间隔小时数")
    .option("--max-concurrency <count>", "更新同步最大并发数")
    .option("--quota-budget <units>", "更新同步配额预算")
    .option("--initial-backfill-days <days>", "更新首次回填天数")
    .option(
      "--cookies-file <path>",
      "更新公开检索 cookie 文件路径；传空字符串清除",
    )
    .option(
      "--cookies-from-browser <spec>",
      "更新浏览器 cookie 来源；传空字符串清除",
    )
    .option("--raw-evidence-retention-days <days>", "更新原始证据保留天数");
}

function addChannelConfigOverrideOptions(command: Command): Command {
  return command
    .option("--channel <channel-id>", "要覆盖的本机频道配置")
    .option("--channel-enabled <true|false>", "更新频道是否启用同步")
    .option("--channel-sync-frequency-hours <hours>", "更新频道同步间隔小时数")
    .option("--channel-max-concurrency <count>", "更新频道同步最大并发数")
    .option("--channel-quota-budget <units>", "更新频道同步配额预算")
    .option("--channel-initial-backfill-days <days>", "更新频道首次回填天数")
    .option(
      "--channel-raw-evidence-retention-days <days>",
      "更新频道原始证据保留天数",
    );
}

function addAnalysisProfileOverrideOptions(command: Command): Command {
  return command
    .option("--profile <name>", "要覆盖的分析配置档案")
    .option("--profile-metrics <items>", "逗号分隔的分析指标")
    .option("--profile-dimensions <items>", "逗号分隔的分析维度")
    .option("--profile-date-range <range>", "分析时间范围")
    .option(
      "--profile-filter <field=value>",
      "分析筛选条件；可重复提供",
      collectOptionValue,
    );
}

config
  .command("init")
  .description("在明确路径创建不含凭据的默认配置")
  .requiredOption("-o, --output <path>", "配置文件输出路径")
  .option("--overwrite", "允许覆盖明确指定的已有配置文件")
  .action(async (options: { output: string; overwrite?: boolean }) =>
    execute("配置初始化", async () =>
      redactConfigCommandResult(
        await initializeChannelOperationsConfig(
          options.output,
          Boolean(options.overwrite),
        ),
      ),
    ),
  );

config
  .command("explain")
  .description("说明全局、频道和分析配置档案的用途与凭据边界")
  .action(async () =>
    execute("配置说明", async () => explainChannelOperationsConfig()),
  );

const setGlobalConfig = addGlobalConfigOverrideOptions(
  config
    .command("set-global")
    .description("将已校验的全局配置覆盖项持久化到明确路径")
    .requiredOption("-c, --config <path>", "要更新的配置文件路径"),
);

setGlobalConfig.action(
  async (options: { config: string } & GlobalConfigOverrideOptions) =>
    execute("更新全局配置", async () =>
      redactConfigCommandResult(
        await updateGlobalChannelOperationsConfig(
          options.config,
          parseGlobalConfigOverrides(options),
        ),
      ),
    ),
);

const setChannelConfig = addChannelConfigOverrideOptions(
  config
    .command("set-channel")
    .description("将已校验的单频道配置覆盖项持久化到明确路径")
    .requiredOption("-c, --config <path>", "要更新的配置文件路径"),
);

setChannelConfig.action(
  async (options: { config: string } & ChannelConfigOverrideOptions) =>
    execute("更新频道配置", async () =>
      redactConfigCommandResult(
        await updateChannelOperationsConfig(
          options.config,
          requireChannelConfigOverrides(options),
        ),
      ),
    ),
);

const setAnalysisProfileConfig = addAnalysisProfileOverrideOptions(
  config
    .command("set-profile")
    .description("将已校验的分析配置档案覆盖项持久化到明确路径")
    .requiredOption("-c, --config <path>", "要更新的配置文件路径"),
);

setAnalysisProfileConfig.action(
  async (options: { config: string } & AnalysisProfileOverrideOptions) =>
    execute("更新分析配置档案", async () =>
      redactConfigCommandResult(
        await updateAnalysisProfileOperationsConfig(
          options.config,
          requireAnalysisProfileOverrides(options),
        ),
      ),
    ),
);

const validateConfig = addAnalysisProfileOverrideOptions(
  addChannelConfigOverrideOptions(
    addGlobalConfigOverrideOptions(
      config
        .command("validate")
        .description("校验配置格式，并临时检查三层配置覆盖")
        .requiredOption("-c, --config <path>", "要校验的配置文件路径"),
    ),
  ),
);

validateConfig.action(async (options: ConfigCommandOptions) =>
  execute("配置校验", async () =>
    redactConfigCommandResult(
      await validateChannelOperationsConfig(
        options.config,
        parseChannelOperationsConfigOverrides(options),
      ),
    ),
  ),
);

addPublicRetrievalOptions(
  program
    .command("search")
    .description("搜索公开 YouTube 视频并返回精简元数据")
    .argument("<query>", "搜索词")
    .option("-n, --limit <count>", "结果数量，1-50", "10"),
).action(
  async (query: string, options: { limit: string } & PublicCookieOptions) =>
    execute("搜索结果", async () => ({
      query,
      videos: await searchVideos(
        query,
        parseInteger(options.limit, "--limit", 1, 50),
        { cookies: await resolvePublicCookieSettings(options) },
      ),
    })),
);

addPublicRetrievalOptions(
  program
    .command("inspect")
    .description("读取单个公开视频的元数据，不下载媒体")
    .argument("<url>", "视频 URL"),
).action(async (url: string, options: PublicCookieOptions) =>
  execute("视频元数据", async () =>
    inspectVideo(url, {
      cookies: await resolvePublicCookieSettings(options),
    }),
  ),
);

const captions = program.command("captions").description("检查或取得字幕工件");

addPublicRetrievalOptions(
  captions
    .command("list")
    .description("列出公开视频可用的人工和自动字幕语言")
    .argument("<url>", "视频 URL"),
).action(async (url: string, options: PublicCookieOptions) =>
  execute("字幕语言", async () =>
    listCaptionLanguages(url, {
      cookies: await resolvePublicCookieSettings(options),
    }),
  ),
);

addPublicRetrievalOptions(
  captions
    .command("fetch")
    .description("将已获授权内容的指定语言字幕写入明确的输出目录")
    .argument("<url>", "视频 URL")
    .requiredOption(
      "-l, --language <language>",
      "字幕语言，例如 zh-Hans、zh-Hant 或 en",
    )
    .requiredOption("-o, --output-dir <path>", "输出目录")
    .option("--rights-confirmed", "确认你拥有该内容的使用或下载权利"),
).action(
  async (
    url: string,
    options: {
      language: string;
      outputDir: string;
      rightsConfirmed?: boolean;
    } & PublicCookieOptions,
  ) =>
    execute("字幕工件", async () => {
      requireRightsConfirmation(Boolean(options.rightsConfirmed));
      return fetchCaptions(url, options.language, options.outputDir, {
        cookies: await resolvePublicCookieSettings(options),
      });
    }),
);

const download = program
  .command("download")
  .description("下载获授权的媒体到明确的输出目录");

addPublicRetrievalOptions(
  download
    .command("video")
    .description("下载视频；必须显式确认已拥有权利或授权")
    .argument("<url>", "视频 URL")
    .requiredOption("-o, --output-dir <path>", "输出目录")
    .option("-q, --quality <quality>", "best、720p、1080p 等", "best")
    .option("--rights-confirmed", "确认你拥有该内容的使用或下载权利"),
).action(
  async (
    url: string,
    options: {
      outputDir: string;
      quality: string;
      rightsConfirmed?: boolean;
    } & PublicCookieOptions,
  ) =>
    execute("下载结果", async () => {
      requireRightsConfirmation(Boolean(options.rightsConfirmed));
      return downloadMedia(
        "video",
        url,
        options.outputDir,
        normalizeQuality(options.quality),
        { cookies: await resolvePublicCookieSettings(options) },
      );
    }),
);

addPublicRetrievalOptions(
  download
    .command("audio")
    .description("下载音频；必须显式确认已拥有权利或授权")
    .argument("<url>", "视频 URL")
    .requiredOption("-o, --output-dir <path>", "输出目录")
    .option("--rights-confirmed", "确认你拥有该内容的使用或下载权利"),
).action(
  async (
    url: string,
    options: {
      outputDir: string;
      rightsConfirmed?: boolean;
    } & PublicCookieOptions,
  ) =>
    execute("下载结果", async () => {
      requireRightsConfirmation(Boolean(options.rightsConfirmed));
      return downloadMedia("audio", url, options.outputDir, "best", {
        cookies: await resolvePublicCookieSettings(options),
      });
    }),
);

const processCommand = program
  .command("process")
  .description("处理本地媒体文件，不修改原文件");

processCommand
  .command("probe")
  .description("使用 ffprobe 输出本地媒体的结构化信息")
  .argument("<input>", "本地媒体文件")
  .action(async (input: string) =>
    execute("媒体信息", () => probeMedia(input)),
  );

processCommand
  .command("audio")
  .description("从本地媒体提取音频")
  .argument("<input>", "本地媒体文件")
  .requiredOption("-o, --output <path>", "输出文件")
  .option("-f, --format <format>", "mp3、m4a 或 wav", "m4a")
  .option("--overwrite", "允许覆盖已存在的输出文件")
  .action(
    async (
      input: string,
      options: { output: string; format: string; overwrite?: boolean },
    ) =>
      execute("音频工件", async () => {
        const format = z.enum(["mp3", "m4a", "wav"]).safeParse(options.format);
        if (!format.success) {
          throw new UserInputError("--format 只能是 mp3、m4a 或 wav。");
        }
        await extractAudio(
          input,
          options.output,
          format.data,
          Boolean(options.overwrite),
        );
        return { input, output: options.output, format: format.data };
      }),
  );

processCommand
  .command("clip")
  .description("从本地媒体无重编码裁剪片段；输出边界受关键帧影响")
  .argument("<input>", "本地媒体文件")
  .requiredOption("-o, --output <path>", "输出文件")
  .requiredOption("--start <time>", "起始时间，例如 00:01:05")
  .requiredOption("--end <time>", "结束时间，例如 00:01:25")
  .option("--overwrite", "允许覆盖已存在的输出文件")
  .action(
    async (
      input: string,
      options: {
        output: string;
        start: string;
        end: string;
        overwrite?: boolean;
      },
    ) =>
      execute("裁剪工件", async () => {
        await clipMedia(
          input,
          options.output,
          options.start,
          options.end,
          Boolean(options.overwrite),
        );
        return {
          input,
          output: options.output,
          start: options.start,
          end: options.end,
          mode: "stream-copy",
        };
      }),
  );

const operations = program
  .command("ops")
  .description("官方频道运营适配层的环境与权限检查");

function requireEnvironmentValue(name: string, label: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new UserInputError(`未配置 ${label}。请先在本机环境中完成配置。`);
  }
  return value;
}

function defaultOAuthRedirectUri(): string {
  return (
    process.env.YTOPS_GOOGLE_OAUTH_REDIRECT_URI ??
    "http://127.0.0.1:8765/oauth2callback"
  );
}

const channelOperations = operations
  .command("channel")
  .description("启动 OAuth 频道接入、查看频道并显式选择目标频道");

channelOperations
  .command("auth-start")
  .description("生成官方用户 OAuth 授权地址，不执行登录")
  .requiredOption("-c, --config <path>", "已初始化的频道运营配置路径")
  .option("--analytics", "同时申请只读 YouTube Analytics 权限")
  .option(
    "--comments",
    "同时申请评论读取所需的官方权限；应用仍只执行评论列表读取",
  )
  .option(
    "-r, --redirect-uri <uri>",
    "OAuth 回调地址",
    defaultOAuthRedirectUri(),
  )
  .action(
    async (options: {
      config: string;
      redirectUri: string;
      analytics?: boolean;
      comments?: boolean;
    }) =>
      execute("频道 OAuth 授权", () =>
        beginChannelOAuth(options.config, {
          clientId: requireEnvironmentValue(
            "YTOPS_GOOGLE_CLIENT_ID",
            "Google OAuth 客户端 ID",
          ),
          redirectUri: options.redirectUri,
          ...((options.analytics ?? false) || (options.comments ?? false)
            ? {
                scopes: [
                  "https://www.googleapis.com/auth/youtube.readonly",
                  ...(options.analytics
                    ? [YOUTUBE_ANALYTICS_READONLY_SCOPE]
                    : []),
                  ...(options.comments ? [YOUTUBE_FORCE_SSL_SCOPE] : []),
                ],
              }
            : {}),
          ...(options.comments ? { capabilities: { comments: true } } : {}),
        }),
      ),
  );

channelOperations
  .command("auth-complete")
  .description("使用 OAuth 回调参数完成授权并列出可访问频道")
  .requiredOption("-c, --config <path>", "已初始化的频道运营配置路径")
  .requiredOption("--code <code>", "OAuth 回调中的一次性授权码")
  .requiredOption("--state <state>", "OAuth 回调中的 state")
  .action(async (options: { config: string; code: string; state: string }) =>
    execute("频道 OAuth 完成", () =>
      completeChannelOAuth(options.config, {
        code: options.code,
        state: options.state,
        clientSecret: process.env.YTOPS_GOOGLE_CLIENT_SECRET?.trim(),
      }),
    ),
  );

channelOperations
  .command("status")
  .description("查询本机保存的频道接入状态，不输出 OAuth 令牌")
  .requiredOption("-c, --config <path>", "已初始化的频道运营配置路径")
  .action(async (options: { config: string }) =>
    execute("频道接入状态", () =>
      getChannelConnectionStatus(options.config, {
        provider: new GoogleOAuthProvider(),
      }),
    ),
  );

channelOperations
  .command("list")
  .description("列出最近一次 OAuth 授权发现的可访问频道")
  .requiredOption("-c, --config <path>", "已初始化的频道运营配置路径")
  .action(async (options: { config: string }) =>
    execute("可访问频道", async () => {
      const status = await getChannelConnectionStatus(options.config, {
        provider: new GoogleOAuthProvider(),
      });
      return {
        channels: status.availableChannels,
        status: status.status,
        ...(status.reason === undefined ? {} : { reason: status.reason }),
        selectionRequired: status.selectionRequired,
      };
    }),
  );

channelOperations
  .command("select")
  .description("从最近一次 OAuth 发现的列表中显式选择一个频道")
  .requiredOption("-c, --config <path>", "已初始化的频道运营配置路径")
  .requiredOption("--channel <channel-id>", "要建立接入的频道 ID")
  .action(async (options: { config: string; channel: string }) =>
    execute("选择频道接入", () =>
      selectChannelConnection(options.config, options.channel, {
        provider: new GoogleOAuthProvider(),
      }),
    ),
  );

channelOperations
  .command("sync")
  .description("同步已选择频道的频道、上传播放列表和视频元数据")
  .requiredOption("-c, --config <path>", "已初始化的频道运营配置路径")
  .requiredOption("--channel <channel-id>", "要同步的已接入频道 ID")
  .option("--scope <items>", "同步范围：channel、uploads、videos；默认全部")
  .action(
    async (options: { config: string; channel: string; scope?: string }) =>
      execute(
        "频道基础数据同步",
        () =>
          syncInventory(
            options.config,
            {
              channelId: options.channel,
              ...(options.scope === undefined
                ? {}
                : { scope: parseInventoryScope(options.scope) }),
            },
            { provider: new GoogleInventoryProvider() },
          ),
        inventorySyncFailure,
      ),
  );

channelOperations
  .command("sync-status")
  .description("查询频道基础数据同步状态、检查点和数据截至时间")
  .requiredOption("-c, --config <path>", "已初始化的频道运营配置路径")
  .requiredOption("--channel <channel-id>", "要查询的已接入频道 ID")
  .option("--scope <items>", "同步范围：channel、uploads、videos；默认全部")
  .action(
    async (options: { config: string; channel: string; scope?: string }) =>
      execute("频道基础数据同步状态", () =>
        getInventoryStatus(
          options.config,
          options.channel,
          options.scope === undefined
            ? undefined
            : { scope: parseInventoryScope(options.scope) },
        ),
      ),
  );

const scheduler = channelOperations
  .command("scheduler")
  .description("运行和管理一次性频道同步调度周期");

scheduler
  .command("run")
  .description("运行所有已到期的频道 Inventory 任务")
  .requiredOption("-c, --config <path>", "已初始化的频道运营配置路径")
  .action(async (options: { config: string }) =>
    execute(
      "频道同步调度周期",
      () => runDueInventoryTasks(options.config),
      schedulerRunFailure,
    ),
  );

scheduler
  .command("install")
  .description("预览或确认安装 Windows 定期调度任务")
  .requiredOption("-c, --config <path>", "已初始化的频道运营配置路径")
  .option("--yes", "确认执行本机调度适配器状态变更")
  .action(async (options: { config: string; yes?: boolean }) =>
    execute("安装频道同步调度任务", () =>
      installTaskScheduler(options.config, options.yes === true),
    ),
  );

scheduler
  .command("status")
  .description("查看 Windows 定期调度任务状态及配置漂移")
  .requiredOption("-c, --config <path>", "已初始化的频道运营配置路径")
  .action(async (options: { config: string }) =>
    execute("频道同步调度任务状态", () =>
      getTaskSchedulerStatus(options.config),
    ),
  );

scheduler
  .command("disable")
  .description("预览或确认停用 Windows 定期调度任务")
  .requiredOption("-c, --config <path>", "已初始化的频道运营配置路径")
  .option("--yes", "确认执行本机调度适配器状态变更")
  .action(async (options: { config: string; yes?: boolean }) =>
    execute("停用频道同步调度任务", () =>
      disableTaskScheduler(options.config, options.yes === true),
    ),
  );

channelOperations
  .command("analytics-sync")
  .description("同步频道和视频级核心 Analytics 数据")
  .requiredOption("-c, --config <path>", "已初始化的频道运营配置路径")
  .requiredOption("--channel <channel-id>", "要同步的已接入频道 ID")
  .option("--days <days>", "本次回填天数，默认 365，最大 3650")
  .option(
    "--video <video-id>",
    "只同步指定视频，可重复提供",
    collectOptionValue,
  )
  .action(
    async (options: {
      config: string;
      channel: string;
      days?: string;
      video?: string[];
    }) =>
      execute("频道核心 Analytics 同步", () =>
        syncAnalytics(
          options.config,
          {
            channelId: options.channel,
            ...(options.days === undefined
              ? {}
              : { days: parseInteger(options.days, "--days", 1, 3_650) }),
            ...(options.video === undefined ? {} : { videoIds: options.video }),
          },
          { provider: new GoogleAnalyticsProvider() },
        ),
      ),
  );

channelOperations
  .command("analytics-status")
  .description("查询频道核心 Analytics 同步状态和覆盖范围")
  .requiredOption("-c, --config <path>", "已初始化的频道运营配置路径")
  .requiredOption("--channel <channel-id>", "要查询的已接入频道 ID")
  .action(async (options: { config: string; channel: string }) =>
    execute("频道核心 Analytics 状态", () =>
      getAnalyticsStatus(options.config, options.channel),
    ),
  );

channelOperations
  .command("analytics-query")
  .description("查询已保存的频道核心 Analytics 事实")
  .requiredOption("-c, --config <path>", "已初始化的频道运营配置路径")
  .requiredOption("--channel <channel-id>", "要查询的已接入频道 ID")
  .action(async (options: { config: string; channel: string }) =>
    execute("频道核心 Analytics 事实", () =>
      queryAnalytics(options.config, options.channel),
    ),
  );

channelOperations
  .command("analytics-read")
  .description("读取 Analytics 最后可用数据，或显式刷新/强制最新")
  .requiredOption("-c, --config <path>", "已初始化的频道运营配置路径")
  .requiredOption("--channel <channel-id>", "要读取的已接入频道 ID")
  .option("--refresh", "先尝试刷新；失败时返回最后可用数据并标记过期")
  .option("--latest", "要求本次刷新成功；失败时不回退到旧数据")
  .option("--max-age-hours <hours>", "判定缓存过期的小时数，默认 24")
  .action(
    async (options: {
      config: string;
      channel: string;
      refresh?: boolean;
      latest?: boolean;
      maxAgeHours?: string;
    }) => {
      if (options.refresh && options.latest) {
        throw new UserInputError("--refresh 与 --latest 只能选择一个。 ");
      }
      const mode = options.latest
        ? "latest"
        : options.refresh
          ? "refresh"
          : "cached";
      return execute("频道 Analytics 新鲜度查询", () =>
        readAnalyticsFacts(
          options.config,
          {
            channelId: options.channel,
            mode,
            ...(options.maxAgeHours === undefined
              ? {}
              : {
                  maxAgeHours: Number(options.maxAgeHours),
                }),
          },
          {},
        ),
      );
    },
  );

channelOperations
  .command("analytics-breakdown")
  .description("按已校验的分析配置档案查询高维 Analytics")
  .requiredOption("-c, --config <path>", "已初始化的频道运营配置路径")
  .requiredOption("--channel <channel-id>", "要查询的已接入频道 ID")
  .option("--profile <name>", "复用已保存的分析配置档案")
  .option("--metrics <items>", "逗号分隔的指标")
  .option("--dimensions <items>", "逗号分隔的维度")
  .option("--start-date <date>", "开始日期 YYYY-MM-DD")
  .option("--end-date <date>", "结束日期 YYYY-MM-DD")
  .option("--filter <field=value>", "筛选条件，可重复提供", collectOptionValue)
  .option("--revenue-eligible", "确认目标频道具备收入 Analytics 资格")
  .action(
    async (options: {
      config: string;
      channel: string;
      profile?: string;
      metrics?: string;
      dimensions?: string;
      startDate?: string;
      endDate?: string;
      filter?: string[];
      revenueEligible?: boolean;
    }) => {
      const filters = parseProfileFilters(options.filter);
      return execute("高维 Analytics 查询", () =>
        queryBreakdown(
          options.config,
          {
            channelId: options.channel,
            ...(options.profile === undefined
              ? {}
              : { profileName: options.profile }),
            profile: {
              ...(options.metrics === undefined
                ? {}
                : {
                    metrics: parseCommaSeparatedList(
                      options.metrics,
                      "--metrics",
                    ) as never[],
                  }),
              ...(options.dimensions === undefined
                ? {}
                : {
                    dimensions: parseCommaSeparatedList(
                      options.dimensions,
                      "--dimensions",
                    ) as never[],
                  }),
              ...(options.startDate === undefined
                ? {}
                : { startDate: options.startDate }),
              ...(options.endDate === undefined
                ? {}
                : { endDate: options.endDate }),
              ...(filters === undefined ? {} : { filters }),
            },
            ...(options.revenueEligible === undefined
              ? {}
              : { revenueEligible: options.revenueEligible }),
          },
          { provider: new GoogleAnalyticsProvider() },
        ),
      );
    },
  );

channelOperations
  .command("analytics-breakdown-read")
  .description("读取已保存的高维 Analytics 结果")
  .requiredOption("-c, --config <path>", "已初始化的频道运营配置路径")
  .requiredOption("--channel <channel-id>", "要查询的已接入频道 ID")
  .option("--profile <name>", "已保存的分析配置档案")
  .action(
    async (options: { config: string; channel: string; profile?: string }) =>
      execute("高维 Analytics 结果", () =>
        readBreakdownResult(options.config, {
          channelId: options.channel,
          ...(options.profile === undefined
            ? {}
            : { profileName: options.profile }),
        }),
      ),
  );

channelOperations
  .command("analytics-profile-save")
  .description("在确认后保存高维 Analytics 配置档案")
  .requiredOption("-c, --config <path>", "已初始化的频道运营配置路径")
  .requiredOption("--profile <name>", "配置档案名称")
  .requiredOption("--metrics <items>", "逗号分隔的指标")
  .requiredOption("--dimensions <items>", "逗号分隔的维度")
  .option(
    "--date-range <range>",
    "last-7-days、last-28-days 或 last-90-days",
    "last-28-days",
  )
  .option("--filter <field=value>", "筛选条件，可重复提供", collectOptionValue)
  .option("--confirmed", "确认将差异写入配置")
  .action(
    async (options: {
      config: string;
      profile: string;
      metrics: string;
      dimensions: string;
      dateRange: string;
      filter?: string[];
      confirmed?: boolean;
    }) =>
      execute("保存高维 Analytics 配置", () =>
        saveBreakdownProfile(
          options.config,
          options.profile,
          {
            metrics: parseCommaSeparatedList(
              options.metrics,
              "--metrics",
            ) as never[],
            dimensions: parseCommaSeparatedList(
              options.dimensions,
              "--dimensions",
            ) as never[],
            filters: parseProfileFilters(options.filter) ?? {},
            dateRange: options.dateRange,
          },
          Boolean(options.confirmed),
        ),
      ),
  );

channelOperations
  .command("reporting-sync")
  .description("请求、等待或导入异步 Reporting 报告")
  .requiredOption("-c, --config <path>", "已初始化的频道运营配置路径")
  .requiredOption("--channel <channel-id>", "目标频道 ID")
  .requiredOption("--report-type <type>", "官方报告类型")
  .option("--report-id <id>", "继续指定的报告 ID")
  .action(
    async (options: {
      config: string;
      channel: string;
      reportType: string;
      reportId?: string;
    }) =>
      execute("异步 Reporting 同步", () =>
        syncReporting(
          options.config,
          {
            channelId: options.channel,
            reportType: options.reportType,
            ...(options.reportId === undefined
              ? {}
              : { reportId: options.reportId }),
          },
          { provider: new GoogleReportingProvider() },
        ),
      ),
  );

channelOperations
  .command("reporting-status")
  .description("查询异步 Reporting 报告状态，可按报告类型查询")
  .requiredOption("-c, --config <path>", "已初始化的频道运营配置路径")
  .requiredOption("--channel <channel-id>", "目标频道 ID")
  .option(
    "--report-type <type>",
    "官方报告类型；缺省时列出全部已有状态的报告类型",
  )
  .action(
    async (options: {
      config: string;
      channel: string;
      reportType?: string;
    }) => {
      if (options.reportType === undefined) {
        return execute("异步 Reporting 状态", async () => ({
          channelId: options.channel,
          reports: await listReportingResults(options.config, options.channel),
        }));
      }
      return execute("异步 Reporting 状态", () =>
        getReportingStatus(options.config, options.channel, {
          reportType: options.reportType as string,
        }),
      );
    },
  );

channelOperations
  .command("comments-sync")
  .description("只读同步频道评论")
  .requiredOption("-c, --config <path>", "已初始化的频道运营配置路径")
  .requiredOption("--channel <channel-id>", "目标频道 ID")
  .action(async (options: { config: string; channel: string }) =>
    execute("频道评论同步", () =>
      syncComments(
        options.config,
        { channelId: options.channel },
        { provider: new GoogleCommentsProvider() },
      ),
    ),
  );

channelOperations
  .command("comments-status")
  .description("查询只读评论同步状态")
  .requiredOption("-c, --config <path>", "已初始化的频道运营配置路径")
  .requiredOption("--channel <channel-id>", "目标频道 ID")
  .action(async (options: { config: string; channel: string }) =>
    execute("频道评论状态", () =>
      getCommentsStatus(options.config, options.channel),
    ),
  );

channelOperations
  .command("retention-sync")
  .description("同步库存视频的全历史留存曲线，首次全量、之后仅新增视频")
  .requiredOption("-c, --config <path>", "已初始化的频道运营配置路径")
  .requiredOption("--channel <channel-id>", "要同步的已接入频道 ID")
  .action(async (options: { config: string; channel: string }) =>
    execute("频道留存曲线同步", () =>
      syncRetention(
        options.config,
        { channelId: options.channel },
        { provider: new GoogleRetentionProvider() },
      ),
    ),
  );

channelOperations
  .command("retention-status")
  .description("查询留存曲线同步状态、检查点和数据截至时间")
  .requiredOption("-c, --config <path>", "已初始化的频道运营配置路径")
  .requiredOption("--channel <channel-id>", "要查询的已接入频道 ID")
  .action(async (options: { config: string; channel: string }) =>
    execute("频道留存曲线状态", () =>
      getRetentionStatus(options.config, options.channel),
    ),
  );

channelOperations
  .command("retention-read")
  .description("读取单个视频的全历史留存曲线，或刷新/强制最新")
  .requiredOption("-c, --config <path>", "已初始化的频道运营配置路径")
  .requiredOption("--channel <channel-id>", "要读取的已接入频道 ID")
  .requiredOption("--video <video-id>", "单个视频 ID")
  .option("--refresh", "先尝试源站刷新；失败时返回最后可用数据并标记过期")
  .option("--latest", "要求本次源站刷新成功；失败时不回退到旧数据")
  .option("--max-age-hours <hours>", "判定缓存过期的小时数，默认 24")
  .action(
    async (options: {
      config: string;
      channel: string;
      video: string;
      refresh?: boolean;
      latest?: boolean;
      maxAgeHours?: string;
    }) => {
      if (options.refresh && options.latest) {
        throw new UserInputError("--refresh 与 --latest 只能选择一个。 ");
      }
      const mode = options.latest
        ? "latest"
        : options.refresh
          ? "refresh"
          : "cached";
      return execute("视频留存曲线", () =>
        readRetentionCurve(
          options.config,
          {
            channelId: options.channel,
            videoId: options.video,
            mode,
            ...(options.maxAgeHours === undefined
              ? {}
              : { maxAgeHours: Number(options.maxAgeHours) }),
          },
          {},
        ),
      );
    },
  );

channelOperations
  .command("coverage")
  .description("输出频道数据能力覆盖矩阵与证据入口")
  .requiredOption("-c, --config <path>", "已初始化的频道运营配置路径")
  .requiredOption("--channel <channel-id>", "目标频道 ID")
  .action(async (options: { config: string; channel: string }) =>
    execute("频道数据覆盖矩阵", () =>
      getCoverageMatrix(options.config, options.channel),
    ),
  );

operations
  .command("doctor")
  .description("检查可选发布工具与 OAuth 环境变量；不会发起登录或写入频道")
  .action(async () =>
    execute("运营环境检查", async () => ({
      youtubeDataClientIdConfigured: Boolean(
        process.env.YTOPS_GOOGLE_CLIENT_ID,
      ),
      youtubeDataClientSecretConfigured: Boolean(
        process.env.YTOPS_GOOGLE_CLIENT_SECRET,
      ),
      cookiesFileConfigured: Boolean(
        process.env.YTOPS_YTDLP_COOKIES_FILE?.trim(),
      ),
      cookiesFromBrowserConfigured: Boolean(
        process.env.YTOPS_YTDLP_COOKIES_FROM_BROWSER?.trim(),
      ),
      guidance:
        "频道读取、Analytics、上传和更新必须走官方 YouTube API/OAuth，并在每个写操作前提供目标与预览确认。公开检索 cookie 默认不读取；显式 opt-in 时建议使用导出的 cookie 文件或 firefox（Windows 上 Chrome/Edge 受 App-Bound Encryption 限制），并使用专用小号以降低账号风控风险。",
      ...(await runDoctor()),
    })),
  );

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0) {
    if (wantsJson()) {
      emit({ output: jsonCommanderOutput.trimEnd() }, "命令信息");
    }
    process.exitCode = 0;
  } else {
    const payload: ErrorPayload = { ok: false, error: readableError(error) };
    if (wantsJson()) {
      console.log(JSON.stringify(payload, null, 2));
    } else if (!(error instanceof CommanderError)) {
      console.error(`错误：${payload.error.message}`);
      if (payload.error.details) {
        console.error(payload.error.details);
      }
    }
    process.exitCode = error instanceof CommanderError ? error.exitCode : 1;
  }
}
