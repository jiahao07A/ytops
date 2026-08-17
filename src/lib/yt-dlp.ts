import { ExternalCommandError, UserInputError } from "./errors.js";
import { runCommand } from "./process.js";

export type DownloadKind = "video" | "audio";
export type VideoQuality = "best" | `${number}p`;

const SAFE_YTDLP_ARGUMENTS = ["--ignore-config", "--no-warnings", "--no-playlist"];
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const WATCH_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);
const EMBED_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"]);

export interface VideoSummary {
  id: string | null;
  title: string | null;
  url: string | null;
  channel: string | null;
  durationSeconds: number | null;
  viewCount: number | null;
  uploadDate: string | null;
  thumbnail: string | null;
}

function safeYtDlpEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    YTDLP_IGNORE_CONFIG: "1",
  };
}

function isVideoId(value: string | null): value is string {
  return value !== null && VIDEO_ID_PATTERN.test(value);
}

function isEmbeddedVideoPath(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  return (
    segments.length === 2 &&
    ["shorts", "live", "embed"].includes(segments[0]) &&
    isVideoId(segments[1])
  );
}

function isAllowedYouTubeVideoUrl(parsed: URL): boolean {
  if (parsed.port !== "" || parsed.username !== "" || parsed.password !== "") {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "youtu.be") {
    return isVideoId(parsed.pathname.slice(1));
  }

  if (WATCH_HOSTS.has(hostname) && parsed.pathname === "/watch") {
    return isVideoId(parsed.searchParams.get("v"));
  }

  return EMBED_HOSTS.has(hostname) && isEmbeddedVideoPath(parsed.pathname);
}

function assertYouTubeUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new UserInputError("URL 必须是完整的 HTTPS YouTube 地址。");
  }

  if (parsed.protocol !== "https:") {
    throw new UserInputError("只允许 HTTPS URL。");
  }

  if (!isAllowedYouTubeVideoUrl(parsed)) {
    throw new UserInputError(
      "只允许 HTTPS 单视频 YouTube URL，不允许跳转端点、用户信息或非默认端口。",
    );
  }
}

async function runYtDlp(args: string[]) {
  try {
    return await runCommand("yt-dlp", args, { env: safeYtDlpEnvironment() });
  } catch {
    throw new UserInputError("找不到 yt-dlp。请先安装并确认它位于 PATH 中，然后运行 ytops doctor。");
  }
}

async function readJson(args: string[]): Promise<Record<string, unknown>> {
  const result = await runYtDlp(args);
  if (result.exitCode !== 0) {
    throw new ExternalCommandError(result.command, result.args, result.exitCode, result.stderr);
  }

  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new ExternalCommandError(result.command, result.args, result.exitCode, "yt-dlp did not return valid JSON.");
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function summarizeVideo(raw: Record<string, unknown>): VideoSummary {
  return {
    id: asString(raw.id),
    title: asString(raw.title),
    url: asString(raw.webpage_url) ?? asString(raw.original_url),
    channel: asString(raw.channel) ?? asString(raw.uploader),
    durationSeconds: asNumber(raw.duration),
    viewCount: asNumber(raw.view_count),
    uploadDate: asString(raw.upload_date),
    thumbnail: asString(raw.thumbnail),
  };
}

export async function searchVideos(query: string, limit: number): Promise<VideoSummary[]> {
  if (query.trim().length === 0) {
    throw new UserInputError("搜索词不能为空。");
  }

  const raw = await readJson([
    ...SAFE_YTDLP_ARGUMENTS,
    "--skip-download",
    "--dump-single-json",
    `ytsearch${limit}:${query}`,
  ]);
  const entries = Array.isArray(raw.entries) ? raw.entries : [];

  return entries
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map(summarizeVideo);
}

export async function inspectVideo(url: string): Promise<VideoSummary & { description: string | null }> {
  assertYouTubeUrl(url);
  const raw = await readJson([...SAFE_YTDLP_ARGUMENTS, "--skip-download", "--dump-single-json", url]);
  return {
    ...summarizeVideo(raw),
    description: asString(raw.description),
  };
}

export interface CaptionLanguages {
  manual: string[];
  automatic: string[];
}

export async function listCaptionLanguages(url: string): Promise<CaptionLanguages> {
  assertYouTubeUrl(url);
  const raw = await readJson([...SAFE_YTDLP_ARGUMENTS, "--skip-download", "--dump-single-json", url]);
  const subtitles = typeof raw.subtitles === "object" && raw.subtitles !== null ? raw.subtitles : {};
  const automaticCaptions =
    typeof raw.automatic_captions === "object" && raw.automatic_captions !== null ? raw.automatic_captions : {};

  return {
    manual: Object.keys(subtitles),
    automatic: Object.keys(automaticCaptions),
  };
}

export function normalizeQuality(value: string): VideoQuality {
  if (value === "best") {
    return value;
  }

  if (!/^\d{3,4}p$/.test(value)) {
    throw new UserInputError("清晰度必须是 best 或类似 720p、1080p 的值。");
  }

  return value as VideoQuality;
}

export function buildDownloadArguments(
  kind: DownloadKind,
  url: string,
  outputDirectory: string,
  quality: VideoQuality,
): string[] {
  assertYouTubeUrl(url);
  const output = [
    ...SAFE_YTDLP_ARGUMENTS,
    "--paths",
    outputDirectory,
    "--print",
    "after_move:filepath",
  ];

  if (kind === "audio") {
    return [...output, "--extract-audio", "--audio-format", "m4a", url];
  }

  const format = quality === "best" ? "bv*+ba/b" : `bv*[height<=${quality.slice(0, -1)}]+ba/b[height<=${quality.slice(0, -1)}]/b`;
  return [...output, "--format", format, "--merge-output-format", "mp4", url];
}

export async function downloadMedia(
  kind: DownloadKind,
  url: string,
  outputDirectory: string,
  quality: VideoQuality,
): Promise<{ outputDirectory: string; files: string[] }> {
  const result = await runYtDlp(buildDownloadArguments(kind, url, outputDirectory, quality));
  if (result.exitCode !== 0) {
    throw new ExternalCommandError(result.command, result.args, result.exitCode, result.stderr);
  }

  return {
    outputDirectory,
    files: result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
  };
}

export async function fetchCaptions(
  url: string,
  language: string,
  outputDirectory: string,
): Promise<{ outputDirectory: string; files: string[] }> {
  assertYouTubeUrl(url);
  if (language.trim().length === 0) {
    throw new UserInputError("字幕语言不能为空，例如 zh-Hans、zh-Hant 或 en。");
  }

  const result = await runYtDlp([
    ...SAFE_YTDLP_ARGUMENTS,
    "--skip-download",
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs",
    language,
    "--sub-format",
    "srt/vtt/best",
    "--convert-subs",
    "srt",
    "--paths",
    outputDirectory,
    "--print",
    "after_move:filepath",
    url,
  ]);
  if (result.exitCode !== 0) {
    throw new ExternalCommandError(result.command, result.args, result.exitCode, result.stderr);
  }

  return {
    outputDirectory,
    files: result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
  };
}
