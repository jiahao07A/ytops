import { ExternalCommandError, UserInputError } from "./errors.js";
import {
  createCommandLaunchFailure,
  ExternalToolError,
  runCommand,
  type CommandRunner,
} from "./process.js";

export { ExternalToolError } from "./process.js";

export type DownloadKind = "video" | "audio";
export type VideoQuality = "best" | `${number}p`;

const SAFE_YTDLP_ARGUMENTS = [
  "--ignore-config",
  "--no-warnings",
  "--no-playlist",
];
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const WATCH_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);
const EMBED_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

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

export interface CookieSettings {
  file?: string;
  fromBrowser?: string;
}

export interface YtDlpOptions {
  runner?: CommandRunner;
  cookies?: CookieSettings;
}

function safeYtDlpEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    YTDLP_IGNORE_CONFIG: "1",
  };
}

export function cookieArguments(cookies: CookieSettings | undefined): string[] {
  if (cookies === undefined) {
    return [];
  }
  if (cookies.file !== undefined && cookies.fromBrowser !== undefined) {
    throw new UserInputError(
      "一次只能使用一种 cookie 来源：cookie 文件与浏览器 cookie 不能同时提供。",
    );
  }
  if (cookies.file !== undefined) {
    return ["--cookies", cookies.file];
  }
  if (cookies.fromBrowser !== undefined) {
    return ["--cookies-from-browser", cookies.fromBrowser];
  }
  return [];
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

async function runYtDlp(args: string[], runner: CommandRunner = runCommand) {
  try {
    const result = await runner("yt-dlp", args, {
      env: safeYtDlpEnvironment(),
    });
    if (result.launchFailure) {
      throw new ExternalToolError(
        result.command,
        result.args,
        result.launchFailure.kind,
        undefined,
        result.launchFailure.detail,
      );
    }
    return result;
  } catch (error) {
    if (error instanceof ExternalToolError) {
      throw error;
    }
    const failure = createCommandLaunchFailure(error);
    throw new ExternalToolError(
      "yt-dlp",
      args,
      failure.kind,
      undefined,
      failure.detail,
    );
  }
}

async function readJson(
  args: string[],
  options: YtDlpOptions = {},
): Promise<Record<string, unknown>> {
  const result = await runYtDlp(args, options.runner);
  if (result.exitCode !== 0) {
    throw new ExternalToolError(
      result.command,
      result.args,
      "non-zero-exit",
      result.exitCode,
      `命令以退出码 ${result.exitCode ?? "未知"} 结束。`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new ExternalToolError(
      result.command,
      result.args,
      "malformed-output",
      result.exitCode,
      "yt-dlp 未返回可解析的 JSON。",
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ExternalToolError(
      result.command,
      result.args,
      "invalid-output",
      result.exitCode,
      "yt-dlp JSON 响应必须是对象。",
    );
  }

  return parsed as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hasVideoIdentity(raw: Record<string, unknown>): boolean {
  return (
    asString(raw.id) !== null &&
    asString(raw.title) !== null &&
    (asString(raw.webpage_url) ?? asString(raw.original_url)) !== null
  );
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

export async function searchVideos(
  query: string,
  limit: number,
  options: YtDlpOptions = {},
): Promise<VideoSummary[]> {
  if (query.trim().length === 0) {
    throw new UserInputError("搜索词不能为空。");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new UserInputError("搜索结果数量必须是 1 到 50 之间的整数。");
  }

  const args = [
    ...SAFE_YTDLP_ARGUMENTS,
    ...cookieArguments(options.cookies),
    "--skip-download",
    "--dump-single-json",
    `ytsearch${limit}:${query}`,
  ];
  const raw = await readJson(args, options);
  if (!Array.isArray(raw.entries)) {
    throw new ExternalToolError(
      "yt-dlp",
      args,
      "invalid-output",
      0,
      "yt-dlp 搜索响应缺少 entries 数组。",
    );
  }
  const entries = raw.entries;
  if (
    entries.some(
      (entry) =>
        typeof entry !== "object" || entry === null || Array.isArray(entry),
    )
  ) {
    throw new ExternalToolError(
      "yt-dlp",
      args,
      "invalid-output",
      0,
      "yt-dlp 搜索响应包含无效条目。",
    );
  }
  const videoEntries = entries as Record<string, unknown>[];
  if (videoEntries.some((entry) => !hasVideoIdentity(entry))) {
    throw new ExternalToolError(
      "yt-dlp",
      args,
      "invalid-output",
      0,
      "yt-dlp 搜索响应条目缺少 id、title 或 URL。",
    );
  }

  return videoEntries.map(summarizeVideo);
}

export async function inspectVideo(
  url: string,
  options: YtDlpOptions = {},
): Promise<VideoSummary & { description: string | null }> {
  assertYouTubeUrl(url);
  const args = [
    ...SAFE_YTDLP_ARGUMENTS,
    ...cookieArguments(options.cookies),
    "--skip-download",
    "--dump-single-json",
    url,
  ];
  const raw = await readJson(args, options);
  if (!hasVideoIdentity(raw)) {
    throw new ExternalToolError(
      "yt-dlp",
      args,
      "invalid-output",
      0,
      "yt-dlp 视频响应缺少 id、title 或 URL。",
    );
  }
  return {
    ...summarizeVideo(raw),
    description: asString(raw.description),
  };
}

export interface CaptionLanguages {
  manual: string[];
  automatic: string[];
}

export async function listCaptionLanguages(
  url: string,
  options: YtDlpOptions = {},
): Promise<CaptionLanguages> {
  assertYouTubeUrl(url);
  const args = [
    ...SAFE_YTDLP_ARGUMENTS,
    ...cookieArguments(options.cookies),
    "--skip-download",
    "--dump-single-json",
    url,
  ];
  const raw = await readJson(args, options);
  if (
    typeof raw.subtitles !== "object" ||
    raw.subtitles === null ||
    Array.isArray(raw.subtitles) ||
    typeof raw.automatic_captions !== "object" ||
    raw.automatic_captions === null ||
    Array.isArray(raw.automatic_captions)
  ) {
    throw new ExternalToolError(
      "yt-dlp",
      args,
      "invalid-output",
      0,
      "yt-dlp 字幕响应缺少语言集合。",
    );
  }
  const subtitles = raw.subtitles;
  const automaticCaptions = raw.automatic_captions;

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
  cookies?: CookieSettings,
): string[] {
  assertYouTubeUrl(url);
  const output = [
    ...SAFE_YTDLP_ARGUMENTS,
    ...cookieArguments(cookies),
    "--paths",
    outputDirectory,
    "--print",
    "after_move:filepath",
  ];

  if (kind === "audio") {
    return [...output, "--extract-audio", "--audio-format", "m4a", url];
  }

  const format =
    quality === "best"
      ? "bv*+ba/b"
      : `bv*[height<=${quality.slice(0, -1)}]+ba/b[height<=${quality.slice(0, -1)}]/b`;
  return [...output, "--format", format, "--merge-output-format", "mp4", url];
}

export async function downloadMedia(
  kind: DownloadKind,
  url: string,
  outputDirectory: string,
  quality: VideoQuality,
  options: YtDlpOptions = {},
): Promise<{ outputDirectory: string; files: string[] }> {
  const result = await runYtDlp(
    buildDownloadArguments(
      kind,
      url,
      outputDirectory,
      quality,
      options.cookies,
    ),
    options.runner,
  );
  if (result.exitCode !== 0) {
    throw new ExternalCommandError(
      result.command,
      result.args,
      result.exitCode,
      result.stderr,
    );
  }

  return {
    outputDirectory,
    files: result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  };
}

export async function fetchCaptions(
  url: string,
  language: string,
  outputDirectory: string,
  options: YtDlpOptions = {},
): Promise<{ outputDirectory: string; files: string[] }> {
  assertYouTubeUrl(url);
  if (language.trim().length === 0) {
    throw new UserInputError("字幕语言不能为空，例如 zh-Hans、zh-Hant 或 en。");
  }

  const result = await runYtDlp(
    [
      ...SAFE_YTDLP_ARGUMENTS,
      ...cookieArguments(options.cookies),
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
    ],
    options.runner,
  );
  if (result.exitCode !== 0) {
    throw new ExternalCommandError(
      result.command,
      result.args,
      result.exitCode,
      result.stderr,
    );
  }

  return {
    outputDirectory,
    files: result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  };
}
