#!/usr/bin/env node
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
  redactConfigurationPathForOutput,
  updateAnalysisProfileOperationsConfig,
  updateChannelOperationsConfig,
  updateGlobalChannelOperationsConfig,
  validateChannelOperationsConfig,
} from "./lib/config.js";
import { runDoctor } from "./lib/doctor.js";
import { ExternalCommandError, UserInputError } from "./lib/errors.js";
import { clipMedia, extractAudio, probeMedia } from "./lib/media.js";
import {
  downloadMedia,
  fetchCaptions,
  inspectVideo,
  listCaptionLanguages,
  normalizeQuality,
  searchVideos,
} from "./lib/yt-dlp.js";

interface GlobalOptions {
  json?: boolean;
}

interface ErrorPayload {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: string;
  };
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

function parseGlobalConfigOverrides(
  options: GlobalConfigOverrideOptions,
): GlobalConfigOverrides {
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
  if (error instanceof ExternalCommandError) {
    return {
      code: error.code,
      message: safeErrorMessage(error.message),
      details: safeErrorMessage(error.stderr || "外部工具没有返回可读错误。"),
    };
  }
  if (error instanceof Error) {
    return { code: "UNEXPECTED", message: safeErrorMessage(error.message) };
  }
  return { code: "UNEXPECTED", message: "发生未知错误。" };
}

async function execute(
  title: string,
  task: () => Promise<unknown>,
): Promise<void> {
  try {
    emit(await task(), title);
  } catch (error) {
    const payload: ErrorPayload = { ok: false, error: readableError(error) };
    if (wantsJson()) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.error(`错误：${payload.error.message}`);
      if (payload.error.details) {
        console.error(payload.error.details);
      }
    }
    process.exitCode = 1;
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

program
  .command("search")
  .description("搜索公开 YouTube 视频并返回精简元数据")
  .argument("<query>", "搜索词")
  .option("-n, --limit <count>", "结果数量，1-50", "10")
  .action(async (query: string, options: { limit: string }) =>
    execute("搜索结果", async () => ({
      query,
      videos: await searchVideos(
        query,
        parseInteger(options.limit, "--limit", 1, 50),
      ),
    })),
  );

program
  .command("inspect")
  .description("读取单个公开视频的元数据，不下载媒体")
  .argument("<url>", "视频 URL")
  .action(async (url: string) =>
    execute("视频元数据", () => inspectVideo(url)),
  );

const captions = program.command("captions").description("检查或取得字幕工件");

captions
  .command("list")
  .description("列出公开视频可用的人工和自动字幕语言")
  .argument("<url>", "视频 URL")
  .action(async (url: string) =>
    execute("字幕语言", () => listCaptionLanguages(url)),
  );

captions
  .command("fetch")
  .description("将已获授权内容的指定语言字幕写入明确的输出目录")
  .argument("<url>", "视频 URL")
  .requiredOption(
    "-l, --language <language>",
    "字幕语言，例如 zh-Hans、zh-Hant 或 en",
  )
  .requiredOption("-o, --output-dir <path>", "输出目录")
  .option("--rights-confirmed", "确认你拥有该内容的使用或下载权利")
  .action(
    async (
      url: string,
      options: {
        language: string;
        outputDir: string;
        rightsConfirmed?: boolean;
      },
    ) =>
      execute("字幕工件", async () => {
        requireRightsConfirmation(Boolean(options.rightsConfirmed));
        return fetchCaptions(url, options.language, options.outputDir);
      }),
  );

const download = program
  .command("download")
  .description("下载获授权的媒体到明确的输出目录");

download
  .command("video")
  .description("下载视频；必须显式确认已拥有权利或授权")
  .argument("<url>", "视频 URL")
  .requiredOption("-o, --output-dir <path>", "输出目录")
  .option("-q, --quality <quality>", "best、720p、1080p 等", "best")
  .option("--rights-confirmed", "确认你拥有该内容的使用或下载权利")
  .action(
    async (
      url: string,
      options: {
        outputDir: string;
        quality: string;
        rightsConfirmed?: boolean;
      },
    ) =>
      execute("下载结果", async () => {
        requireRightsConfirmation(Boolean(options.rightsConfirmed));
        return downloadMedia(
          "video",
          url,
          options.outputDir,
          normalizeQuality(options.quality),
        );
      }),
  );

download
  .command("audio")
  .description("下载音频；必须显式确认已拥有权利或授权")
  .argument("<url>", "视频 URL")
  .requiredOption("-o, --output-dir <path>", "输出目录")
  .option("--rights-confirmed", "确认你拥有该内容的使用或下载权利")
  .action(
    async (
      url: string,
      options: { outputDir: string; rightsConfirmed?: boolean },
    ) =>
      execute("下载结果", async () => {
        requireRightsConfirmation(Boolean(options.rightsConfirmed));
        return downloadMedia("audio", url, options.outputDir, "best");
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
      guidance:
        "频道读取、Analytics、上传和更新必须走官方 YouTube API/OAuth，并在每个写操作前提供目标与预览确认。",
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
