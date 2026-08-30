import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import isoCountries from "i18n-iso-countries";
import lockfile from "proper-lockfile";
import { z } from "zod";
import {
  CORE_ANALYTICS_METRICS,
  REVENUE_ESTIMATE_METRIC,
  SUPPORTED_ANALYSIS_DIMENSIONS,
} from "./analytics-catalog.js";
import { UserInputError } from "./errors.js";

const protectedCredentialKeyFragments = [
  "accesskey",
  "bearer",
  "cookie",
  "token",
  "secret",
  "password",
  "apikey",
  "credential",
  "authorization",
  "session",
  "privatekey",
  "oauth",
  "jwt",
  "signature",
  "signingkey",
];
const reservedObjectKeys = new Set(["__proto__", "constructor", "prototype"]);
const controlCharacterPattern = /[\u0000-\u001F\u007F]/;
const credentialValuePatterns = [
  /(?:bearer|basic)\s+\S+/i,
  /AIza[A-Za-z0-9_-]{20,}/,
  /ya29\.[A-Za-z0-9._-]+/,
  /1\/\/[A-Za-z0-9_-]+/,
  /GOCSPX-[A-Za-z0-9_-]{8,}/i,
  /-----BEGIN [A-Z ]+-----/m,
  /eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  /(?:^|[^A-Za-z0-9])(?:access[-_.]?(?:token|key)|refresh[-_.]?token|client[-_.]?secret|api[-_.]?key)=/i,
];
const youtubeChannelIdPattern = /^UC[A-Za-z0-9_-]{22}$/;
const youtubeVideoIdPattern = /^[A-Za-z0-9_-]{11}$/;
const supportedAnalysisMetrics = new Set([
  ...CORE_ANALYTICS_METRICS,
  REVENUE_ESTIMATE_METRIC,
]);
const supportedAnalysisDimensions = new Set(SUPPORTED_ANALYSIS_DIMENSIONS);
const supportedAnalysisDateRanges = new Set([
  "last-7-days",
  "last-28-days",
  "last-90-days",
  "last-365-days",
]);
const supportedAnalysisFilters = {
  country: {
    isValid: (value: string) =>
      /^[A-Z]{2}$/.test(value) && isoCountries.isValid(value),
    expectedValue: "两个大写 ISO 3166-1 alpha-2 国家代码",
  },
  channel: {
    isValid: isValidYouTubeChannelId,
    expectedValue: "有效的 YouTube 频道 ID",
  },
  video: {
    isValid: (value: string) => youtubeVideoIdPattern.test(value),
    expectedValue: "有效的 YouTube 视频 ID",
  },
  trafficSourceType: {
    isValid: (value: string) => /^[A-Za-z0-9_-]+$/.test(value),
    expectedValue: "官方 Analytics 流量来源值",
  },
  deviceType: {
    isValid: (value: string) => /^[A-Za-z0-9_-]+$/.test(value),
    expectedValue: "官方 Analytics 设备值",
  },
  ageGroup: {
    isValid: (value: string) => /^[A-Za-z0-9_-]+$/.test(value),
    expectedValue: "官方 Analytics 受众年龄值",
  },
  gender: {
    isValid: (value: string) => /^[A-Za-z0-9_-]+$/.test(value),
    expectedValue: "官方 Analytics 受众性别值",
  },
} as const;

function normalizeConfigurationKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isValidYouTubeChannelId(value: string): boolean {
  return youtubeChannelIdPattern.test(value.trim());
}

export function containsCredentialLikeText(value: string): boolean {
  // Strong credential formats remain sensitive inside arbitrary path and key text.
  return credentialValuePatterns.some((pattern) => pattern.test(value));
}

function isStructuredDataDirectory(value: string): boolean {
  const trimmed = value.trim();
  const isWindowsAbsolutePath = /^[A-Za-z]:[\\/]/.test(trimmed);
  const hasUnsupportedUriScheme =
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed) && !isWindowsAbsolutePath;
  const hasEmbeddedUriScheme = /[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed);
  const hasStructuredLocalPath =
    trimmed.startsWith(".") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\") ||
    isWindowsAbsolutePath ||
    trimmed.includes("/") ||
    trimmed.includes("\\");

  return (
    !controlCharacterPattern.test(trimmed) &&
    !hasUnsupportedUriScheme &&
    !hasEmbeddedUriScheme &&
    !containsCredentialLikeText(trimmed) &&
    hasStructuredLocalPath
  );
}

export function redactConfigurationPathForOutput(path: string): string {
  return containsCredentialLikeText(path) ? "<已隐藏的配置路径>" : path;
}

export function isProtectedCredentialKey(key: string): boolean {
  const normalized = normalizeConfigurationKey(key);
  return protectedCredentialKeyFragments.some((fragment) =>
    normalized.includes(fragment),
  );
}

export function isSafeFreeformConfigurationKey(key: string): boolean {
  const normalized = normalizeConfigurationKey(key);
  return (
    key.trim().length > 0 &&
    !controlCharacterPattern.test(key) &&
    !reservedObjectKeys.has(key.trim().toLowerCase()) &&
    !isProtectedCredentialKey(normalized) &&
    !containsCredentialLikeText(key.trim())
  );
}

export function assertSafeFreeformConfigurationKey(
  key: string,
  label: string,
): void {
  if (!isSafeFreeformConfigurationKey(key)) {
    throw new UserInputError(
      `${label}不能使用受保护凭据或保留字段名。请移除该字段，并通过操作系统受保护凭据存储管理 OAuth 凭据。`,
    );
  }
}

function supportedAnalysisFilter(
  field: string,
):
  | (typeof supportedAnalysisFilters)[keyof typeof supportedAnalysisFilters]
  | undefined {
  if (!Object.hasOwn(supportedAnalysisFilters, field)) {
    return undefined;
  }

  return supportedAnalysisFilters[
    field as keyof typeof supportedAnalysisFilters
  ];
}

function analysisFilterValidationMessage(field: string): string {
  const filter = supportedAnalysisFilter(field);
  if (filter === undefined) {
    return "不支持的分析筛选字段。当前支持：country、channel、video、trafficSourceType、deviceType、ageGroup、gender。";
  }

  return `筛选字段 ${field} 的筛选值只接受${filter.expectedValue}。`;
}

export function isSupportedAnalysisFilter(
  field: string,
  value: string,
): boolean {
  const filter = supportedAnalysisFilter(field);
  return filter !== undefined && filter.isValid(value.trim());
}

export function assertSupportedAnalysisFilter(
  field: string,
  value: string,
): void {
  if (!isSupportedAnalysisFilter(field, value)) {
    throw new UserInputError(analysisFilterValidationMessage(field));
  }
}

function integerSettingSchema(label: string, minimum: number, maximum: number) {
  return z
    .number({ error: `${label}必须是数字。` })
    .int(`${label}必须是整数。`)
    .min(minimum, `${label}必须在 ${minimum} 到 ${maximum} 之间。`)
    .max(maximum, `${label}必须在 ${minimum} 到 ${maximum} 之间。`);
}

const nonEmptyTextSchema = (label: string) =>
  z
    .string({ error: `${label}必须是文本。` })
    .trim()
    .min(1, `${label}不能为空。`);

function cataloguedTextSchema(
  label: string,
  supportedValues: ReadonlySet<string>,
  rule: string,
) {
  return nonEmptyTextSchema(label).refine(
    (value) => supportedValues.has(value),
    { message: `${label}${rule}` },
  );
}

const dataDirectorySchema = nonEmptyTextSchema("本机数据目录").refine(
  isStructuredDataDirectory,
  {
    message: "本机数据目录必须是明确的相对或绝对目录路径。",
  },
);

const supportedCookieBrowsers = new Set([
  "brave",
  "chrome",
  "chromium",
  "edge",
  "firefox",
  "opera",
  "safari",
  "vivaldi",
  "whale",
]);

export function isSupportedCookieBrowserSpec(value: string): boolean {
  const trimmed = value.trim();
  // 仅做词法白名单校验，keyring/profile/container 后缀原样透传给 yt-dlp；
  // 外部命令以 argv 数组启动，spec 中的空格不构成注入风险。
  if (controlCharacterPattern.test(trimmed)) {
    return false;
  }
  const browserToken = trimmed.split(/[+:]/, 1)[0] ?? "";
  return supportedCookieBrowsers.has(browserToken.toLowerCase());
}

const cookieFilePathSchema = nonEmptyTextSchema("cookie 文件路径").refine(
  isStructuredDataDirectory,
  {
    message: "cookie 文件路径必须是明确的相对或绝对文件路径。",
  },
);

const cookieBrowserSpecSchema = nonEmptyTextSchema("浏览器 cookie 来源").refine(
  isSupportedCookieBrowserSpec,
  {
    message:
      "浏览器 cookie 来源必须是 brave、chrome、chromium、edge、firefox、opera、safari、vivaldi 或 whale，可原样附加 yt-dlp 的 keyring、profile 或 container 后缀。",
  },
);

const cookiesSettingsSchema = z
  .object({
    file: cookieFilePathSchema.optional(),
    fromBrowser: cookieBrowserSpecSchema.optional(),
  })
  .strict()
  .refine(
    (cookies) =>
      !(cookies.file !== undefined && cookies.fromBrowser !== undefined),
    { message: "cookie 文件与浏览器 cookie 只能配置其中一种来源。" },
  );

const channelIdSchema = nonEmptyTextSchema("频道 ID").refine(
  isValidYouTubeChannelId,
  {
    message: "频道 ID 必须是有效的 YouTube 频道 ID。",
  },
);

const analysisMetricSchema = cataloguedTextSchema(
  "分析指标",
  supportedAnalysisMetrics,
  "只能使用首期支持的核心指标。",
);

const analysisDimensionSchema = cataloguedTextSchema(
  "分析维度",
  supportedAnalysisDimensions,
  "只能使用首期支持的核心维度。",
);

const analysisDateRangeSchema = cataloguedTextSchema(
  "分析时间范围",
  supportedAnalysisDateRanges,
  "只能使用首期支持的预设时间范围。",
);

const freeformConfigurationKeySchema = nonEmptyTextSchema("配置映射键").refine(
  isSafeFreeformConfigurationKey,
  {
    message:
      "不能使用受保护凭据或保留字段名。请移除该字段，并通过操作系统受保护凭据存储管理 OAuth 凭据。",
  },
);

const recordWithUniqueTrimmedKeysSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return;
    }

    const trimmedKeys = new Set<string>();
    for (const key of Object.keys(value)) {
      const trimmedKey = key.trim();
      if (trimmedKeys.has(trimmedKey)) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "配置映射键在去除首尾空格后不能重复。",
        });
        continue;
      }
      trimmedKeys.add(trimmedKey);
    }
  });

const analysisFiltersSchema = recordWithUniqueTrimmedKeysSchema.pipe(
  z
    .record(freeformConfigurationKeySchema, nonEmptyTextSchema("筛选值"))
    .superRefine((filters, ctx) => {
      for (const [field, value] of Object.entries(filters)) {
        if (!isSupportedAnalysisFilter(field, value)) {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: analysisFilterValidationMessage(field),
          });
        }
      }
    }),
);

const syncSettingsSchema = z
  .object({
    frequencyHours: integerSettingSchema("同步间隔小时数", 1, 168),
    maxConcurrency: integerSettingSchema("最大并发数", 1, 16),
    quotaBudget: integerSettingSchema("配额预算", 1, 1_000_000),
    initialBackfillDays: integerSettingSchema("首次回填天数", 1, 3_650),
  })
  .strict();

const analysisProfileSchema = z
  .object({
    metrics: z.array(analysisMetricSchema).min(1, "至少提供一个分析指标。"),
    dimensions: z
      .array(analysisDimensionSchema)
      .min(1, "至少提供一个分析维度。"),
    dateRange: analysisDateRangeSchema,
    filters: analysisFiltersSchema,
  })
  .strict();

const analysisProfilesSchema = recordWithUniqueTrimmedKeysSchema.pipe(
  z.record(freeformConfigurationKeySchema, analysisProfileSchema),
);

const channelConfigSchema = z
  .object({
    channelId: channelIdSchema,
    enabled: z
      .boolean({ error: "频道启用状态必须是 true 或 false。" })
      .default(true),
    sync: syncSettingsSchema.partial().optional(),
    rawEvidenceRetentionDays: z
      .number({ error: "频道原始证据保留天数必须是数字。" })
      .int("频道原始证据保留天数必须是整数。")
      .min(1, "频道原始证据保留天数必须在 1 到 3650 之间。")
      .max(3_650, "频道原始证据保留天数必须在 1 到 3650 之间。")
      .optional(),
  })
  .strict();

const channelsSchema = z
  .array(channelConfigSchema)
  .superRefine((channels, ctx) => {
    const firstIndexByChannelId = new Map<string, number>();

    channels.forEach((channel, index) => {
      const firstIndex = firstIndexByChannelId.get(channel.channelId);
      if (firstIndex !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: [index, "channelId"],
          message: `频道 ID 不能重复。请保留第 ${firstIndex + 1} 条配置并合并覆盖项。`,
        });
        return;
      }
      firstIndexByChannelId.set(channel.channelId, index);
    });
  });

export const channelOperationsConfigSchema = z
  .object({
    version: z.literal(1),
    global: z
      .object({
        dataDirectory: dataDirectorySchema,
        sync: syncSettingsSchema,
        cookies: cookiesSettingsSchema.optional(),
        rawEvidenceRetentionDays: integerSettingSchema(
          "原始证据保留天数",
          1,
          3_650,
        ),
      })
      .strict(),
    channels: channelsSchema,
    analysisProfiles: analysisProfilesSchema,
  })
  .strict();

export type ChannelOperationsConfig = z.infer<
  typeof channelOperationsConfigSchema
>;

export interface GlobalConfigOverrides {
  dataDirectory?: string;
  sync?: Partial<ChannelOperationsConfig["global"]["sync"]>;
  cookies?: ChannelOperationsConfig["global"]["cookies"] | null;
  rawEvidenceRetentionDays?: number;
}

export interface ChannelConfigOverrides {
  channelId: string;
  enabled?: boolean;
  sync?: Partial<ChannelOperationsConfig["global"]["sync"]>;
  rawEvidenceRetentionDays?: number;
}

export interface AnalysisProfileOverrides {
  name: string;
  metrics?: string[];
  dimensions?: string[];
  dateRange?: string;
  filters?: Record<string, string>;
}

export interface ChannelOperationsConfigOverrides {
  global?: GlobalConfigOverrides;
  channel?: ChannelConfigOverrides;
  analysisProfile?: AnalysisProfileOverrides;
}

export function createDefaultChannelOperationsConfig(): ChannelOperationsConfig {
  return {
    version: 1,
    global: {
      dataDirectory: ".ytops-data",
      sync: {
        frequencyHours: 24,
        maxConcurrency: 1,
        quotaBudget: 10_000,
        initialBackfillDays: 365,
      },
      rawEvidenceRetentionDays: 365,
    },
    channels: [],
    analysisProfiles: {
      corePerformance: {
        metrics: [
          "views",
          "estimatedMinutesWatched",
          "averageViewDuration",
          "likes",
          "comments",
          "shares",
        ],
        dimensions: ["day"],
        dateRange: "last-28-days",
        filters: {},
      },
    },
  };
}

interface ConfigOptionExplanation {
  name: string;
  description: string;
  rule: string;
  temporaryCommand: string;
  persistentCommand: string;
}

interface ConfigLayerExplanation {
  description: string;
  options: ConfigOptionExplanation[];
}

export function explainChannelOperationsConfig(): {
  global: ConfigLayerExplanation;
  channel: ConfigLayerExplanation;
  analysisProfile: ConfigLayerExplanation;
  credentialPolicy: string;
} {
  const validateConfig = "ytops config validate --config <path>";
  const setGlobalConfig = "ytops config set-global --config <path>";
  const validateChannel = `${validateConfig} --channel <channel-id>`;
  const setChannel =
    "ytops config set-channel --config <path> --channel <channel-id>";
  const validateNewProfile =
    `${validateConfig} --profile <name> --profile-metrics <items> ` +
    "--profile-dimensions <items> --profile-date-range <range>";
  const setNewProfile =
    "ytops config set-profile --config <path> --profile <name> " +
    "--profile-metrics <items> --profile-dimensions <items> " +
    "--profile-date-range <range>";

  return {
    global: {
      description:
        "全局运行配置为所有频道提供默认的数据目录、同步节奏、原始证据保留策略，以及可选的公开检索 cookie 来源（默认关闭）。",
      options: [
        {
          name: "global.dataDirectory",
          description: "本机运营数据仓库的目录。",
          rule: "必须是明确的相对或绝对目录路径；不会保存 OAuth 凭据。",
          temporaryCommand: `${validateConfig} --data-directory <path>`,
          persistentCommand: `${setGlobalConfig} --data-directory <path>`,
        },
        {
          name: "global.sync.frequencyHours",
          description: "默认自动同步的间隔小时数。",
          rule: "必须是 1 到 168 之间的整数，默认值为 24。",
          temporaryCommand: `${validateConfig} --sync-frequency-hours <hours>`,
          persistentCommand: `${setGlobalConfig} --sync-frequency-hours <hours>`,
        },
        {
          name: "global.sync.maxConcurrency",
          description: "默认同步可同时运行的最大工作数。",
          rule: "必须是 1 到 16 之间的整数，默认值为 1。",
          temporaryCommand: `${validateConfig} --max-concurrency <count>`,
          persistentCommand: `${setGlobalConfig} --max-concurrency <count>`,
        },
        {
          name: "global.sync.quotaBudget",
          description: "单个同步周期可使用的官方 API 配额预算。",
          rule: "必须是 1 到 1000000 之间的整数，默认值为 10000。",
          temporaryCommand: `${validateConfig} --quota-budget <units>`,
          persistentCommand: `${setGlobalConfig} --quota-budget <units>`,
        },
        {
          name: "global.sync.initialBackfillDays",
          description: "新频道接入时的首次回填窗口。",
          rule: "必须是 1 到 3650 之间的整数，默认值为 365。",
          temporaryCommand: `${validateConfig} --initial-backfill-days <days>`,
          persistentCommand: `${setGlobalConfig} --initial-backfill-days <days>`,
        },
        {
          name: "global.cookies.file",
          description:
            "显式提供给公开检索命令的 Netscape cookie 文件路径；默认不设置。",
          rule: "必须是明确的相对或绝对文件路径（相对路径按 CLI 进程工作目录解析，命令行 --cookies 也接受裸文件名）；不能与 global.cookies.fromBrowser 同时设置；cookie 文件内容不属于配置。",
          temporaryCommand: `${validateConfig} --cookies-file <path>`,
          persistentCommand: `${setGlobalConfig} --cookies-file <path>`,
        },
        {
          name: "global.cookies.fromBrowser",
          description:
            "显式要求 yt-dlp 从指定浏览器读取 cookie；Windows 上 Chrome/Edge 受 App-Bound Encryption 限制，推荐 firefox。",
          rule: "浏览器必须是 brave、chrome、chromium、edge、firefox、opera、safari、vivaldi 或 whale，可原样附加 yt-dlp 的 keyring、profile 或 container 后缀；不能与 global.cookies.file 同时设置。",
          temporaryCommand: `${validateConfig} --cookies-from-browser <spec>`,
          persistentCommand: `${setGlobalConfig} --cookies-from-browser <spec>`,
        },
        {
          name: "global.rawEvidenceRetentionDays",
          description: "原始证据在本机保留的默认天数。",
          rule: "必须是 1 到 3650 之间的整数，默认值为 365。",
          temporaryCommand: `${validateConfig} --raw-evidence-retention-days <days>`,
          persistentCommand: `${setGlobalConfig} --raw-evidence-retention-days <days>`,
        },
      ],
    },
    channel: {
      description:
        "单频道同步配置只记录本机策略，不会建立频道接入、发起 OAuth 或访问 YouTube。",
      options: [
        {
          name: "channels[].channelId",
          description: "要覆盖全局默认值的明确频道 ID。",
          rule: "必须是有效的 YouTube 频道 ID；同一频道使用同一条本地配置。",
          temporaryCommand: `${validateChannel} --channel-enabled true`,
          persistentCommand: `${setChannel} --channel-enabled true`,
        },
        {
          name: "channels[].enabled",
          description: "该频道是否使用本机同步计划。",
          rule: "必须是 true 或 false；默认值为 true。",
          temporaryCommand: `${validateChannel} --channel-enabled <true|false>`,
          persistentCommand: `${setChannel} --channel-enabled <true|false>`,
        },
        {
          name: "channels[].sync.frequencyHours",
          description: "覆盖该频道的同步间隔小时数。",
          rule: "必须是 1 到 168 之间的整数；未设置时继承全局值。",
          temporaryCommand: `${validateChannel} --channel-sync-frequency-hours <hours>`,
          persistentCommand: `${setChannel} --channel-sync-frequency-hours <hours>`,
        },
        {
          name: "channels[].sync.maxConcurrency",
          description: "覆盖该频道的同步最大并发数。",
          rule: "必须是 1 到 16 之间的整数；未设置时继承全局值。",
          temporaryCommand: `${validateChannel} --channel-max-concurrency <count>`,
          persistentCommand: `${setChannel} --channel-max-concurrency <count>`,
        },
        {
          name: "channels[].sync.quotaBudget",
          description: "覆盖该频道单个同步周期的配额预算。",
          rule: "必须是 1 到 1000000 之间的整数；未设置时继承全局值。",
          temporaryCommand: `${validateChannel} --channel-quota-budget <units>`,
          persistentCommand: `${setChannel} --channel-quota-budget <units>`,
        },
        {
          name: "channels[].sync.initialBackfillDays",
          description: "覆盖该频道首次回填窗口。",
          rule: "必须是 1 到 3650 之间的整数；未设置时继承全局值。",
          temporaryCommand: `${validateChannel} --channel-initial-backfill-days <days>`,
          persistentCommand: `${setChannel} --channel-initial-backfill-days <days>`,
        },
        {
          name: "channels[].rawEvidenceRetentionDays",
          description: "覆盖该频道的原始证据保留期。",
          rule: "必须是 1 到 3650 之间的整数；未设置时继承全局值。",
          temporaryCommand: `${validateChannel} --channel-raw-evidence-retention-days <days>`,
          persistentCommand: `${setChannel} --channel-raw-evidence-retention-days <days>`,
        },
      ],
    },
    analysisProfile: {
      description:
        "分析配置档案保存可复用的查询口径；它只描述数据需求，不执行查询或同步。",
      options: [
        {
          name: "analysisProfiles.<name>",
          description: "分析配置档案的唯一名称。",
          rule: "必须是非空且不含凭据或保留字段名的文本。",
          temporaryCommand: validateNewProfile,
          persistentCommand: setNewProfile,
        },
        {
          name: "analysisProfiles.<name>.metrics",
          description: "要请求的指标列表。",
          rule: "支持核心指标及 estimatedRevenue；CLI 使用逗号分隔列表。收入结果必须标记估算或资格限制。",
          temporaryCommand: validateNewProfile,
          persistentCommand: setNewProfile,
        },
        {
          name: "analysisProfiles.<name>.dimensions",
          description: "要请求的维度列表。",
          rule: "支持 day、video、trafficSourceType、deviceType、country、ageGroup、gender；CLI 使用逗号分隔列表。",
          temporaryCommand: validateNewProfile,
          persistentCommand: setNewProfile,
        },
        {
          name: "analysisProfiles.<name>.dateRange",
          description: "可复用的查询时间范围。",
          rule: "首期支持 last-7-days、last-28-days、last-90-days、last-365-days。",
          temporaryCommand: validateNewProfile,
          persistentCommand: setNewProfile,
        },
        {
          name: "analysisProfiles.<name>.filters",
          description: "按字段保存的筛选条件。",
          rule: "支持 country、channel、video；每个字段可提供一次，country 使用已分配的两个大写国家代码。",
          temporaryCommand: `${validateNewProfile} --profile-filter country=US`,
          persistentCommand: `${setNewProfile} --profile-filter country=US`,
        },
      ],
    },
    credentialPolicy:
      "OAuth 凭据只应由操作系统受保护凭据存储管理，不属于配置文件、日志或 CLI JSON 输出。cookie 文件内容同样绝不写入配置、日志或 CLI JSON 输出；配置最多保存其本机路径。",
  };
}

export async function initializeChannelOperationsConfig(
  outputPath: string,
  overwrite: boolean,
): Promise<{ created: true; configPath: string }> {
  const configPath = resolve(outputPath);
  await withConfigLock(configPath, () =>
    writeChannelOperationsConfig(
      configPath,
      createDefaultChannelOperationsConfig(),
      overwrite,
    ),
  );

  return { created: true, configPath };
}

function safeConfigurationPath(path: readonly PropertyKey[]): string {
  const segments = path.map(String);
  const analysisProfileIndex = segments.indexOf("analysisProfiles");

  if (analysisProfileIndex !== -1) {
    return segments.includes("filters")
      ? "analysisProfiles.<档案>.filters"
      : "analysisProfiles.<档案>";
  }

  return segments.length === 0 ? "根配置" : segments.join(".");
}

function safeIssueMessage(issue: z.ZodError["issues"][number]): string {
  if (issue.code === "invalid_key") {
    return "不能使用受保护凭据或保留字段名。请删除该字段，并通过操作系统受保护凭据存储管理 OAuth 凭据。";
  }

  if (issue.code === "unrecognized_keys") {
    return "不允许未声明的配置字段。请删除该字段；OAuth 凭据必须保存在操作系统受保护凭据存储中。";
  }

  return issue.message;
}

function configurationErrorMessage(error: z.ZodError): string {
  const issues = [
    ...new Set(
      error.issues.map(
        (issue) =>
          `${safeConfigurationPath(issue.path)}：${safeIssueMessage(issue)}`,
      ),
    ),
  ];

  return `配置格式无效。请修正：${issues.join("；")}`;
}

function parseConfiguration(value: unknown): ChannelOperationsConfig {
  const parsed = channelOperationsConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new UserInputError(configurationErrorMessage(parsed.error));
  }
  return parsed.data;
}

export async function validateChannelOperationsConfig(
  inputPath: string,
  overrides: ChannelOperationsConfigOverrides = {},
): Promise<{
  valid: true;
  configPath: string;
  config: ChannelOperationsConfig;
}> {
  const configPath = resolve(inputPath);
  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    throw new UserInputError("无法读取有效的 JSON 配置文件。");
  }

  return {
    valid: true,
    configPath,
    config: applyChannelOperationsConfigOverrides(
      parseConfiguration(parsedJson),
      overrides,
    ),
  };
}

export function applyGlobalConfigOverrides(
  config: ChannelOperationsConfig,
  overrides: GlobalConfigOverrides,
): ChannelOperationsConfig {
  return parseConfiguration({
    ...config,
    global: {
      ...config.global,
      dataDirectory: overrides.dataDirectory ?? config.global.dataDirectory,
      sync: {
        ...config.global.sync,
        ...overrides.sync,
      },
      ...(overrides.cookies === undefined
        ? {}
        : { cookies: overrides.cookies ?? undefined }),
      rawEvidenceRetentionDays:
        overrides.rawEvidenceRetentionDays ??
        config.global.rawEvidenceRetentionDays,
    },
  });
}

export function applyChannelConfigOverrides(
  config: ChannelOperationsConfig,
  overrides: ChannelConfigOverrides,
): ChannelOperationsConfig {
  const channelId = overrides.channelId.trim();
  const existingChannel = config.channels.find(
    (channel) => channel.channelId === channelId,
  );
  const hasSyncOverrides = Object.keys(overrides.sync ?? {}).length > 0;
  const updatedChannel = {
    ...(existingChannel ?? { channelId, enabled: true }),
    ...(overrides.enabled === undefined ? {} : { enabled: overrides.enabled }),
    ...(hasSyncOverrides
      ? {
          sync: {
            ...existingChannel?.sync,
            ...overrides.sync,
          },
        }
      : {}),
    ...(overrides.rawEvidenceRetentionDays === undefined
      ? {}
      : { rawEvidenceRetentionDays: overrides.rawEvidenceRetentionDays }),
  };

  return parseConfiguration({
    ...config,
    channels: existingChannel
      ? config.channels.map((channel) =>
          channel.channelId === channelId ? updatedChannel : channel,
        )
      : [...config.channels, updatedChannel],
  });
}

export function applyAnalysisProfileOverrides(
  config: ChannelOperationsConfig,
  overrides: AnalysisProfileOverrides,
): ChannelOperationsConfig {
  const profileName = overrides.name.trim();
  assertSafeFreeformConfigurationKey(profileName, "分析配置档案名称");
  const existingProfile = Object.hasOwn(config.analysisProfiles, profileName)
    ? config.analysisProfiles[profileName]
    : undefined;

  if (
    existingProfile === undefined &&
    (overrides.metrics === undefined ||
      overrides.dimensions === undefined ||
      overrides.dateRange === undefined)
  ) {
    throw new UserInputError(
      "新建分析配置档案时，必须同时提供 --profile-metrics、--profile-dimensions 和 --profile-date-range。",
    );
  }

  const updatedProfile = {
    metrics: overrides.metrics ?? existingProfile?.metrics,
    dimensions: overrides.dimensions ?? existingProfile?.dimensions,
    dateRange: overrides.dateRange ?? existingProfile?.dateRange,
    filters:
      overrides.filters === undefined
        ? (existingProfile?.filters ?? {})
        : { ...existingProfile?.filters, ...overrides.filters },
  };

  return parseConfiguration({
    ...config,
    analysisProfiles: {
      ...config.analysisProfiles,
      [profileName]: updatedProfile,
    },
  });
}

export function applyChannelOperationsConfigOverrides(
  config: ChannelOperationsConfig,
  overrides: ChannelOperationsConfigOverrides,
): ChannelOperationsConfig {
  let effectiveConfig = config;

  if (overrides.global !== undefined) {
    effectiveConfig = applyGlobalConfigOverrides(
      effectiveConfig,
      overrides.global,
    );
  }
  if (overrides.channel !== undefined) {
    effectiveConfig = applyChannelConfigOverrides(
      effectiveConfig,
      overrides.channel,
    );
  }
  if (overrides.analysisProfile !== undefined) {
    effectiveConfig = applyAnalysisProfileOverrides(
      effectiveConfig,
      overrides.analysisProfile,
    );
  }

  return effectiveConfig;
}

function hasGlobalOverrides(overrides: GlobalConfigOverrides): boolean {
  return (
    overrides.dataDirectory !== undefined ||
    overrides.rawEvidenceRetentionDays !== undefined ||
    overrides.cookies !== undefined ||
    Object.keys(overrides.sync ?? {}).length > 0
  );
}

function hasChannelOverrides(overrides: ChannelConfigOverrides): boolean {
  return (
    overrides.enabled !== undefined ||
    overrides.rawEvidenceRetentionDays !== undefined ||
    Object.keys(overrides.sync ?? {}).length > 0
  );
}

function hasAnalysisProfileOverrides(
  overrides: AnalysisProfileOverrides,
): boolean {
  return (
    overrides.metrics !== undefined ||
    overrides.dimensions !== undefined ||
    overrides.dateRange !== undefined ||
    overrides.filters !== undefined
  );
}

async function writeChannelOperationsConfig(
  configPath: string,
  config: ChannelOperationsConfig,
  overwrite = true,
): Promise<void> {
  await assertConfigPathIsNotHardLinked(configPath);
  const directory = dirname(configPath);
  const temporaryPath = resolve(
    directory,
    `.${basename(configPath)}.${randomUUID()}.tmp`,
  );

  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });

    if (overwrite) {
      await rename(temporaryPath, configPath);
    } else {
      await link(temporaryPath, configPath);
    }
  } catch (error) {
    if (
      !overwrite &&
      error instanceof Error &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      throw new UserInputError(
        "配置文件已存在。如需覆盖，请明确添加 --overwrite。",
      );
    }
    throw error;
  } finally {
    try {
      await unlink(temporaryPath);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        throw error;
      }
    }
  }
}

function isFileSystemErrorWithCode(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

async function assertConfigPathIsNotHardLinked(
  configPath: string,
): Promise<void> {
  const fileStats = await existingConfigFileStats(configPath);
  assertSingleConfigFileLink(fileStats);
}

async function existingConfigFileStats(
  configPath: string,
): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  try {
    return await stat(configPath);
  } catch (error) {
    if (isFileSystemErrorWithCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function assertSingleConfigFileLink(
  fileStats: Awaited<ReturnType<typeof stat>> | undefined,
): void {
  // POSIX 目录的 nlink 恒 >= 2（. 与 ..），只有常规文件才可能构成硬链接别名。
  if (fileStats !== undefined && fileStats.isFile() && fileStats.nlink > 1) {
    throw new UserInputError(
      "配置文件不能通过硬链接共享。请使用单独的配置文件路径后再更新。",
    );
  }
}

async function configIdentityLockPath(
  configPath: string,
): Promise<string | undefined> {
  const fileStats = await existingConfigFileStats(configPath);
  assertSingleConfigFileLink(fileStats);
  if (fileStats === undefined) {
    return undefined;
  }

  // Keep a second lock keyed by the current file identity so aliases that
  // resolve to the same directory entry cannot update independently.
  return resolve(
    tmpdir(),
    "ytops-config-locks",
    `${String(fileStats.dev)}-${String(fileStats.ino)}`,
  );
}

async function withConfigLock<T>(
  configPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const identityLockPath = await configIdentityLockPath(configPath);
  const lockPaths = [configPath];
  if (identityLockPath !== undefined) {
    lockPaths.push(identityLockPath);
  }
  const releases: Array<() => Promise<void>> = [];

  try {
    await mkdir(dirname(configPath), { recursive: true });
    if (identityLockPath !== undefined) {
      await mkdir(dirname(identityLockPath), { recursive: true });
    }
    for (const lockPath of lockPaths) {
      releases.push(
        await lockfile.lock(lockPath, {
          // A config path may not exist before `config init`; all writers use
          // this absolute path so they still contend on the same lock directory.
          realpath: false,
          stale: 30_000,
          update: 10_000,
          retries: {
            retries: 100,
            minTimeout: 25,
            maxTimeout: 250,
          },
        }),
      );
    }
  } catch (error) {
    await Promise.all(
      releases.reverse().map(async (releaseLock) => releaseLock()),
    );
    if (isFileSystemErrorWithCode(error, "ELOCKED")) {
      throw new UserInputError(
        "配置文件正被另一个进程更新。请稍后重试，或确认持锁进程已结束。",
      );
    }
    throw error;
  }

  try {
    return await operation();
  } finally {
    await Promise.all(
      releases.reverse().map(async (releaseLock) => releaseLock()),
    );
  }
}

async function updatePersistedChannelOperationsConfig(
  inputPath: string,
  overrides: ChannelOperationsConfigOverrides,
): Promise<{
  updated: true;
  configPath: string;
  config: ChannelOperationsConfig;
}> {
  const configPath = resolve(inputPath);

  return withConfigLock(configPath, async () => {
    const validated = await validateChannelOperationsConfig(
      configPath,
      overrides,
    );
    await writeChannelOperationsConfig(validated.configPath, validated.config);

    return {
      updated: true,
      configPath: validated.configPath,
      config: validated.config,
    };
  });
}

export async function updateGlobalChannelOperationsConfig(
  inputPath: string,
  overrides: GlobalConfigOverrides,
): Promise<{
  updated: true;
  configPath: string;
  config: ChannelOperationsConfig;
}> {
  if (!hasGlobalOverrides(overrides)) {
    throw new UserInputError("至少提供一个可持久化的全局配置覆盖项。");
  }

  return updatePersistedChannelOperationsConfig(inputPath, {
    global: overrides,
  });
}

export async function updateChannelOperationsConfig(
  inputPath: string,
  overrides: ChannelConfigOverrides,
): Promise<{
  updated: true;
  configPath: string;
  config: ChannelOperationsConfig;
}> {
  if (!hasChannelOverrides(overrides)) {
    throw new UserInputError("至少提供一个可持久化的频道配置覆盖项。");
  }

  return updatePersistedChannelOperationsConfig(inputPath, {
    channel: overrides,
  });
}

export async function updateAnalysisProfileOperationsConfig(
  inputPath: string,
  overrides: AnalysisProfileOverrides,
): Promise<{
  updated: true;
  configPath: string;
  config: ChannelOperationsConfig;
}> {
  if (!hasAnalysisProfileOverrides(overrides)) {
    throw new UserInputError("至少提供一个可持久化的分析档案覆盖项。");
  }

  return updatePersistedChannelOperationsConfig(inputPath, {
    analysisProfile: overrides,
  });
}
