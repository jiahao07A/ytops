import {
  hasAnyRevenueOptIn,
  validateChannelOperationsConfig,
} from "./config.js";
import {
  createCommandLaunchFailure,
  runCommand,
  type CommandRunner,
  type ExternalToolFailure,
} from "./process.js";

export interface ToolCheck {
  name: string;
  required: boolean;
  available: boolean;
  version: string | null;
  detail: string | null;
  failure: ExternalToolFailure | null;
}

export interface DoctorOptions {
  runner?: CommandRunner;
  operationsConfigPath?: string;
}

async function checkCommand(
  name: string,
  args: string[],
  required: boolean,
  runner: CommandRunner,
  options: Parameters<CommandRunner>[2] = {},
): Promise<ToolCheck> {
  try {
    const result = await runner(name, args, options);
    if (result.launchFailure) {
      return {
        name,
        required,
        available: false,
        version: null,
        detail: result.launchFailure.detail,
        failure: result.launchFailure,
      };
    }
    if (result.exitCode !== 0) {
      const detail = `命令以退出码 ${result.exitCode ?? "未知"} 结束。`;
      return {
        name,
        required,
        available: false,
        version: null,
        detail,
        failure: {
          kind: "non-zero-exit",
          exitCode: result.exitCode ?? null,
          detail,
        },
      };
    }

    const version = (result.stdout || result.stderr)
      .split(/\r?\n/)
      .find(Boolean)
      ?.trim();
    if (!version) {
      const detail = "命令未返回可识别的版本信息。";
      return {
        name,
        required,
        available: false,
        version: null,
        detail,
        failure: {
          kind: "malformed-output",
          exitCode: 0,
          detail,
        },
      };
    }

    return {
      name,
      required,
      available: true,
      version,
      detail: null,
      failure: null,
    };
  } catch (error) {
    const failure = createCommandLaunchFailure(error);
    return {
      name,
      required,
      available: false,
      version: null,
      detail: failure.detail,
      failure,
    };
  }
}

export async function runDoctor(options: DoctorOptions = {}): Promise<{
  tools: ToolCheck[];
  safeDefaults: Record<string, string>;
}> {
  const runner = options.runner ?? runCommand;
  const tools = await Promise.all([
    checkCommand("yt-dlp", ["--version", "--ignore-config"], true, runner, {
      env: { ...process.env, YTDLP_IGNORE_CONFIG: "1" },
    }),
    checkCommand("ffmpeg", ["-version"], true, runner),
    checkCommand("ffprobe", ["-version"], true, runner),
    checkCommand("whisper-cli", ["--help"], false, runner),
    checkCommand("auto-editor", ["--version"], false, runner),
    checkCommand("youtubeuploader", ["--version"], false, runner),
  ]);

  const cookieSourceConfigured =
    Boolean(process.env.YTOPS_YTDLP_COOKIES_FILE?.trim()) ||
    Boolean(process.env.YTOPS_YTDLP_COOKIES_FROM_BROWSER?.trim());

  // 只报告 opt-in 状态，不读取或输出任何配置值（ADR 0003）。
  let analyticsRevenueOptIn = "not-configured";
  if (options.operationsConfigPath !== undefined) {
    try {
      const { config } = await validateChannelOperationsConfig(
        options.operationsConfigPath,
      );
      analyticsRevenueOptIn = hasAnyRevenueOptIn(config)
        ? "opted-in"
        : "not-configured";
    } catch {
      analyticsRevenueOptIn = "not-configured";
    }
  }

  return {
    tools,
    safeDefaults: {
      YTDLP_IGNORE_CONFIG: "1",
      cookieAccess: cookieSourceConfigured ? "environment-opt-in" : "disabled",
      oauthWriteAccess: "not configured",
      analyticsRevenueOptIn,
    },
  };
}
