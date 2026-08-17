import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { ExternalCommandError, UserInputError } from "./errors.js";
import { runCommand } from "./process.js";

async function assertReadableFile(filePath: string): Promise<void> {
  try {
    await access(filePath, constants.R_OK);
  } catch {
    throw new UserInputError(`无法读取本地媒体文件：${filePath}`);
  }
}

async function ensureOutputDirectory(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

async function runFfmpeg(args: string[]): Promise<void> {
  let result;
  try {
    result = await runCommand("ffmpeg", args);
  } catch {
    throw new UserInputError(
      "找不到 ffmpeg。请先安装并确认它位于 PATH 中，然后运行 ytops doctor。",
    );
  }

  if (result.exitCode !== 0) {
    throw new ExternalCommandError(
      result.command,
      result.args,
      result.exitCode,
      result.stderr,
    );
  }
}

export async function probeMedia(
  input: string,
): Promise<Record<string, unknown>> {
  await assertReadableFile(input);
  let result;
  try {
    result = await runCommand("ffprobe", [
      "-v",
      "error",
      "-show_format",
      "-show_streams",
      "-of",
      "json",
      input,
    ]);
  } catch {
    throw new UserInputError(
      "找不到 ffprobe。请确认 FFmpeg 已完整安装并位于 PATH 中。",
    );
  }

  if (result.exitCode !== 0) {
    throw new ExternalCommandError(
      result.command,
      result.args,
      result.exitCode,
      result.stderr,
    );
  }

  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new ExternalCommandError(
      result.command,
      result.args,
      result.exitCode,
      "ffprobe did not return valid JSON.",
    );
  }
}

export async function extractAudio(
  input: string,
  output: string,
  format: "mp3" | "m4a" | "wav",
  overwrite: boolean,
): Promise<void> {
  await assertReadableFile(input);
  await ensureOutputDirectory(output);
  const codecs = { mp3: "libmp3lame", m4a: "aac", wav: "pcm_s16le" } as const;
  await runFfmpeg([
    "-hide_banner",
    "-nostdin",
    overwrite ? "-y" : "-n",
    "-i",
    input,
    "-map",
    "0:a:0",
    "-vn",
    "-c:a",
    codecs[format],
    output,
  ]);
}

export async function clipMedia(
  input: string,
  output: string,
  start: string,
  end: string,
  overwrite: boolean,
): Promise<void> {
  await assertReadableFile(input);
  if (start.trim().length === 0 || end.trim().length === 0) {
    throw new UserInputError("裁剪必须提供 --start 和 --end，例如 00:01:05。");
  }

  await ensureOutputDirectory(output);
  await runFfmpeg([
    "-hide_banner",
    "-nostdin",
    overwrite ? "-y" : "-n",
    "-ss",
    start,
    "-to",
    end,
    "-i",
    input,
    "-c",
    "copy",
    output,
  ]);
}
