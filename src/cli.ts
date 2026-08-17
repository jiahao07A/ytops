#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { z } from "zod";
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
  return process.argv.slice(2).includes("--json") || Boolean((program.opts() as GlobalOptions).json);
}

function emit(value: unknown, title: string): void {
  if (wantsJson()) {
    console.log(JSON.stringify({ ok: true, data: value }, null, 2));
    return;
  }

  console.log(title);
  console.log(JSON.stringify(value, null, 2));
}

function parseInteger(value: string, name: string, minimum: number, maximum: number): number {
  const parsed = z.coerce.number().int().min(minimum).max(maximum).safeParse(value);
  if (!parsed.success) {
    throw new UserInputError(`${name} 必须是 ${minimum} 到 ${maximum} 之间的整数。`);
  }
  return parsed.data;
}

function requireRightsConfirmation(confirmed: boolean): void {
  if (!confirmed) {
    throw new UserInputError(
      "下载会写入媒体文件。请确认你拥有内容权利或已获授权后，重新添加 --rights-confirmed。",
    );
  }
}

function readableError(error: unknown): ErrorPayload["error"] {
  if (error instanceof CommanderError) {
    return { code: error.code, message: error.message.trim() };
  }
  if (error instanceof UserInputError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof ExternalCommandError) {
    return {
      code: error.code,
      message: error.message,
      details: error.stderr || "外部工具没有返回可读错误。",
    };
  }
  if (error instanceof Error) {
    return { code: "UNEXPECTED", message: error.message };
  }
  return { code: "UNEXPECTED", message: "发生未知错误。" };
}

async function execute(title: string, task: () => Promise<unknown>): Promise<void> {
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

program
  .command("search")
  .description("搜索公开 YouTube 视频并返回精简元数据")
  .argument("<query>", "搜索词")
  .option("-n, --limit <count>", "结果数量，1-50", "10")
  .action(async (query: string, options: { limit: string }) =>
    execute("搜索结果", async () => ({
      query,
      videos: await searchVideos(query, parseInteger(options.limit, "--limit", 1, 50)),
    })),
  );

program
  .command("inspect")
  .description("读取单个公开视频的元数据，不下载媒体")
  .argument("<url>", "视频 URL")
  .action(async (url: string) => execute("视频元数据", () => inspectVideo(url)));

const captions = program.command("captions").description("检查或取得字幕工件");

captions
  .command("list")
  .description("列出公开视频可用的人工和自动字幕语言")
  .argument("<url>", "视频 URL")
  .action(async (url: string) => execute("字幕语言", () => listCaptionLanguages(url)));

captions
  .command("fetch")
  .description("将已获授权内容的指定语言字幕写入明确的输出目录")
  .argument("<url>", "视频 URL")
  .requiredOption("-l, --language <language>", "字幕语言，例如 zh-Hans、zh-Hant 或 en")
  .requiredOption("-o, --output-dir <path>", "输出目录")
  .option("--rights-confirmed", "确认你拥有该内容的使用或下载权利")
  .action(async (url: string, options: { language: string; outputDir: string; rightsConfirmed?: boolean }) =>
    execute("字幕工件", async () => {
      requireRightsConfirmation(Boolean(options.rightsConfirmed));
      return fetchCaptions(url, options.language, options.outputDir);
    }),
  );

const download = program.command("download").description("下载获授权的媒体到明确的输出目录");

download
  .command("video")
  .description("下载视频；必须显式确认已拥有权利或授权")
  .argument("<url>", "视频 URL")
  .requiredOption("-o, --output-dir <path>", "输出目录")
  .option("-q, --quality <quality>", "best、720p、1080p 等", "best")
  .option("--rights-confirmed", "确认你拥有该内容的使用或下载权利")
  .action(async (url: string, options: { outputDir: string; quality: string; rightsConfirmed?: boolean }) =>
    execute("下载结果", async () => {
      requireRightsConfirmation(Boolean(options.rightsConfirmed));
      return downloadMedia("video", url, options.outputDir, normalizeQuality(options.quality));
    }),
  );

download
  .command("audio")
  .description("下载音频；必须显式确认已拥有权利或授权")
  .argument("<url>", "视频 URL")
  .requiredOption("-o, --output-dir <path>", "输出目录")
  .option("--rights-confirmed", "确认你拥有该内容的使用或下载权利")
  .action(async (url: string, options: { outputDir: string; rightsConfirmed?: boolean }) =>
    execute("下载结果", async () => {
      requireRightsConfirmation(Boolean(options.rightsConfirmed));
      return downloadMedia("audio", url, options.outputDir, "best");
    }),
  );

const processCommand = program.command("process").description("处理本地媒体文件，不修改原文件");

processCommand
  .command("probe")
  .description("使用 ffprobe 输出本地媒体的结构化信息")
  .argument("<input>", "本地媒体文件")
  .action(async (input: string) => execute("媒体信息", () => probeMedia(input)));

processCommand
  .command("audio")
  .description("从本地媒体提取音频")
  .argument("<input>", "本地媒体文件")
  .requiredOption("-o, --output <path>", "输出文件")
  .option("-f, --format <format>", "mp3、m4a 或 wav", "m4a")
  .option("--overwrite", "允许覆盖已存在的输出文件")
  .action(async (input: string, options: { output: string; format: string; overwrite?: boolean }) =>
    execute("音频工件", async () => {
      const format = z.enum(["mp3", "m4a", "wav"]).safeParse(options.format);
      if (!format.success) {
        throw new UserInputError("--format 只能是 mp3、m4a 或 wav。");
      }
      await extractAudio(input, options.output, format.data, Boolean(options.overwrite));
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
  .action(async (input: string, options: { output: string; start: string; end: string; overwrite?: boolean }) =>
    execute("裁剪工件", async () => {
      await clipMedia(input, options.output, options.start, options.end, Boolean(options.overwrite));
      return { input, output: options.output, start: options.start, end: options.end, mode: "stream-copy" };
    }),
  );

const operations = program.command("ops").description("官方频道运营适配层的环境与权限检查");

operations
  .command("doctor")
  .description("检查可选发布工具与 OAuth 环境变量；不会发起登录或写入频道")
  .action(async () =>
    execute("运营环境检查", async () => ({
      youtubeDataClientIdConfigured: Boolean(process.env.YTOPS_GOOGLE_CLIENT_ID),
      youtubeDataClientSecretConfigured: Boolean(process.env.YTOPS_GOOGLE_CLIENT_SECRET),
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
