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

  return {
    tools,
    safeDefaults: {
      YTDLP_IGNORE_CONFIG: "1",
      cookieAccess: "disabled",
      oauthWriteAccess: "not configured",
    },
  };
}
