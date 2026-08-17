import { runCommand } from "./process.js";

export interface ToolCheck {
  name: string;
  required: boolean;
  available: boolean;
  version: string | null;
  detail: string | null;
}

async function checkCommand(name: string, args: string[], required: boolean): Promise<ToolCheck> {
  try {
    const result = await runCommand(name, args);
    const available = result.exitCode === 0;
    return {
      name,
      required,
      available,
      version: available ? (result.stdout || result.stderr).split(/\r?\n/).find(Boolean)?.trim() ?? null : null,
      detail: available ? null : result.stderr || `退出码：${result.exitCode ?? "未知"}`,
    };
  } catch {
    return {
      name,
      required,
      available: false,
      version: null,
      detail: "未在 PATH 中找到命令。",
    };
  }
}

export async function runDoctor(): Promise<{ tools: ToolCheck[]; safeDefaults: Record<string, string> }> {
  const tools = await Promise.all([
    checkCommand("yt-dlp", ["--version"], true),
    checkCommand("ffmpeg", ["-version"], true),
    checkCommand("ffprobe", ["-version"], true),
    checkCommand("whisper-cli", ["--help"], false),
    checkCommand("auto-editor", ["--version"], false),
    checkCommand("youtubeuploader", ["--version"], false),
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
