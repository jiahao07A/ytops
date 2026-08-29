import { describe, expect, it } from "vitest";
import { UserInputError } from "../src/lib/errors.js";
import type { CommandResult } from "../src/lib/process.js";
import {
  buildDownloadArguments,
  cookieArguments,
  ExternalToolError,
  inspectVideo,
  listCaptionLanguages,
  normalizeQuality,
  searchVideos,
  summarizeVideo,
} from "../src/lib/yt-dlp.js";

describe("cookie argument construction", () => {
  it("appends the cookie file after the safe default arguments", () => {
    const args = buildDownloadArguments(
      "video",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "D:\\authorized-output",
      "best",
      { file: "D:\\secrets\\cookies.txt" },
    );

    expect(args.slice(0, 3)).toEqual([
      "--ignore-config",
      "--no-warnings",
      "--no-playlist",
    ]);
    expect(args).toContain("--cookies");
    expect(args[args.indexOf("--cookies") + 1]).toBe(
      "D:\\secrets\\cookies.txt",
    );
  });

  it("passes the browser cookie spec through verbatim", () => {
    expect(cookieArguments({ fromBrowser: "firefox:dev-edition" })).toEqual([
      "--cookies-from-browser",
      "firefox:dev-edition",
    ]);
    expect(cookieArguments(undefined)).toEqual([]);
    expect(cookieArguments({})).toEqual([]);
  });

  it("rejects providing both cookie sources at the wrapper boundary", () => {
    expect(() =>
      cookieArguments({ file: "a.txt", fromBrowser: "firefox" }),
    ).toThrow(UserInputError);
    expect(() =>
      buildDownloadArguments(
        "audio",
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "D:\\output",
        "best",
        { file: "a.txt", fromBrowser: "firefox" },
      ),
    ).toThrow(UserInputError);
  });

  it("keeps the ignore-config boundary while cookies are enabled", async () => {
    const seenArguments: string[][] = [];
    const runner = async (
      command: string,
      args: string[],
    ): Promise<CommandResult> => {
      seenArguments.push(args);
      return {
        command,
        args,
        exitCode: 0,
        stdout: JSON.stringify({
          entries: [
            {
              id: "dQw4w9WgXcQ",
              title: "Example",
              webpage_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            },
          ],
        }),
        stderr: "",
      };
    };

    await searchVideos("test query", 1, {
      runner,
      cookies: { file: "cookies.txt" },
    });

    expect(seenArguments[0]).toContain("--ignore-config");
    expect(seenArguments[0]).toContain("--cookies");
  });
});

describe("yt-dlp command construction", () => {
  it("forces the safe configuration boundary for video downloads", () => {
    const args = buildDownloadArguments(
      "video",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "D:\\authorized-output",
      "1080p",
    );

    expect(args).toContain("--ignore-config");
    expect(args).toContain("--no-playlist");
    expect(args).toContain("--merge-output-format");
    expect(args).toContain("mp4");
    expect(args).toContain("bv*[height<=1080]+ba/b[height<=1080]/b");
  });

  it("uses yt-dlp audio extraction rather than a custom downloader", () => {
    const args = buildDownloadArguments(
      "audio",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "D:\\authorized-output",
      "best",
    );

    expect(args).toContain("--extract-audio");
    expect(args).toContain("--audio-format");
    expect(args).toContain("m4a");
  });

  it("rejects malformed quality and unsafe URL inputs before spawning yt-dlp", () => {
    expect(() => normalizeQuality("unlimited")).toThrow(UserInputError);
    expect(() =>
      buildDownloadArguments(
        "video",
        "file:///local/video",
        "D:\\output",
        "best",
      ),
    ).toThrow(UserInputError);
    expect(() =>
      buildDownloadArguments(
        "video",
        "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "D:\\output",
        "best",
      ),
    ).toThrow(UserInputError);
    expect(() =>
      buildDownloadArguments(
        "video",
        "https://localhost/watch?v=dQw4w9WgXcQ",
        "D:\\output",
        "best",
      ),
    ).toThrow(UserInputError);
    expect(() =>
      buildDownloadArguments(
        "video",
        "https://youtube.com.example/watch?v=dQw4w9WgXcQ",
        "D:\\output",
        "best",
      ),
    ).toThrow(UserInputError);
    expect(() =>
      buildDownloadArguments(
        "video",
        "https://www.youtube.com/redirect?q=http%3A%2F%2F127.0.0.1%3A8080",
        "D:\\output",
        "best",
      ),
    ).toThrow(UserInputError);
    expect(() =>
      buildDownloadArguments(
        "video",
        "https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ",
        "D:\\output",
        "best",
      ),
    ).toThrow(UserInputError);
    expect(() =>
      buildDownloadArguments(
        "video",
        "https://user@www.youtube.com/watch?v=dQw4w9WgXcQ",
        "D:\\output",
        "best",
      ),
    ).toThrow(UserInputError);
    expect(() =>
      buildDownloadArguments(
        "video",
        "https://[::1]/watch?v=dQw4w9WgXcQ",
        "D:\\output",
        "best",
      ),
    ).toThrow(UserInputError);
  });

  it("accepts supported HTTPS single-video YouTube URL forms", () => {
    expect(() =>
      buildDownloadArguments(
        "video",
        "https://youtu.be/dQw4w9WgXcQ",
        "D:\\output",
        "best",
      ),
    ).not.toThrow();
    expect(() =>
      buildDownloadArguments(
        "video",
        "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
        "D:\\output",
        "best",
      ),
    ).not.toThrow();
    expect(() =>
      buildDownloadArguments(
        "video",
        "https://www.youtube.com/shorts/dQw4w9WgXcQ",
        "D:\\output",
        "best",
      ),
    ).not.toThrow();
  });
});

describe("video summaries", () => {
  it("maps the stable subset of yt-dlp metadata", () => {
    expect(
      summarizeVideo({
        id: "abc123",
        title: "Example",
        webpage_url: "https://www.youtube.com/watch?v=abc123",
        channel: "Example channel",
        duration: 42,
        view_count: 1000,
        upload_date: "20260816",
        thumbnail: "https://img.example/thumbnail.jpg",
      }),
    ).toEqual({
      id: "abc123",
      title: "Example",
      url: "https://www.youtube.com/watch?v=abc123",
      channel: "Example channel",
      durationSeconds: 42,
      viewCount: 1000,
      uploadDate: "20260816",
      thumbnail: "https://img.example/thumbnail.jpg",
    });
  });
});

describe("public search contract", () => {
  it("rejects an out-of-range result limit before starting yt-dlp", async () => {
    let started = false;
    const runner = async (
      command: string,
      args: string[],
    ): Promise<CommandResult> => {
      started = true;
      return { command, args, exitCode: 0, stdout: "{}", stderr: "" };
    };

    await expect(searchVideos("test query", 0, { runner })).rejects.toThrow(
      UserInputError,
    );
    expect(started).toBe(false);
  });

  it("returns stable summaries from a controlled yt-dlp runner", async () => {
    const runner = async (
      command: string,
      args: string[],
    ): Promise<CommandResult> => ({
      command,
      args,
      exitCode: 0,
      stdout: JSON.stringify({
        entries: [
          {
            id: "dQw4w9WgXcQ",
            title: "Example",
            webpage_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            channel: "Example channel",
            duration: 42,
            view_count: 1000,
            upload_date: "20260816",
            thumbnail: "https://img.example/thumbnail.jpg",
          },
        ],
      }),
      stderr: "",
    });

    await expect(searchVideos("test query", 1, { runner })).resolves.toEqual([
      {
        id: "dQw4w9WgXcQ",
        title: "Example",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        channel: "Example channel",
        durationSeconds: 42,
        viewCount: 1000,
        uploadDate: "20260816",
        thumbnail: "https://img.example/thumbnail.jpg",
      },
    ]);
  });

  it("classifies a missing yt-dlp executable without exposing the launch error", async () => {
    const secret = "cookie=do-not-echo";
    const runner = async (): Promise<CommandResult> => {
      throw Object.assign(new Error(`spawn failed ${secret}`), {
        code: "ENOENT",
      });
    };

    let caught: unknown;
    try {
      await searchVideos("test query", 1, { runner });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ExternalToolError);
    expect(caught).toMatchObject({
      code: "EXTERNAL_COMMAND",
      kind: "missing",
      exitCode: undefined,
      stderr: "未在 PATH 中找到命令。",
    });
    expect(JSON.stringify(caught)).not.toContain(secret);
  });

  it("preserves launch failure classification returned by a non-rejecting runner", async () => {
    const runner = async (
      command: string,
      args: string[],
    ): Promise<CommandResult> => ({
      command,
      args,
      exitCode: undefined,
      stdout: "",
      stderr: "",
      launchFailure: {
        kind: "missing",
        exitCode: null,
        detail: "未在 PATH 中找到命令。",
      },
    });

    await expect(
      searchVideos("test query", 1, { runner }),
    ).rejects.toMatchObject({
      name: "ExternalToolError",
      kind: "missing",
      stderr: "未在 PATH 中找到命令。",
    });
  });

  it("classifies a permission-denied yt-dlp executable", async () => {
    const runner = async (): Promise<CommandResult> => {
      throw Object.assign(new Error("sensitive operating-system detail"), {
        code: "EACCES",
      });
    };

    await expect(
      searchVideos("test query", 1, { runner }),
    ).rejects.toMatchObject({
      name: "ExternalToolError",
      kind: "permission-denied",
      stderr: "没有执行该命令的权限。",
    });
  });

  it("classifies a damaged or otherwise unlaunchable yt-dlp executable", async () => {
    const runner = async (): Promise<CommandResult> => {
      throw Object.assign(new Error("invalid executable format"), {
        code: "ENOEXEC",
      });
    };

    await expect(
      searchVideos("test query", 1, { runner }),
    ).rejects.toMatchObject({
      name: "ExternalToolError",
      kind: "unlaunchable",
      stderr: "命令存在，但无法启动或不是有效的可执行文件。",
    });
  });

  it("classifies a non-zero yt-dlp exit without exposing stderr", async () => {
    const secret = "authorization=do-not-echo";
    const runner = async (
      command: string,
      args: string[],
    ): Promise<CommandResult> => ({
      command,
      args,
      exitCode: 7,
      stdout: "",
      stderr: secret,
    });

    let caught: unknown;
    try {
      await searchVideos("test query", 1, { runner });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      name: "ExternalToolError",
      kind: "non-zero-exit",
      exitCode: 7,
      stderr: "命令以退出码 7 结束。",
    });
    expect(JSON.stringify(caught)).not.toContain(secret);
  });

  it("classifies malformed yt-dlp JSON separately from an empty result", async () => {
    const runner = async (
      command: string,
      args: string[],
    ): Promise<CommandResult> => ({
      command,
      args,
      exitCode: 0,
      stdout: "not-json",
      stderr: "",
    });

    await expect(
      searchVideos("test query", 1, { runner }),
    ).rejects.toMatchObject({
      name: "ExternalToolError",
      kind: "malformed-output",
      stderr: "yt-dlp 未返回可解析的 JSON。",
    });
  });

  it("rejects a search response that omits the entries collection", async () => {
    const runner = async (
      command: string,
      args: string[],
    ): Promise<CommandResult> => ({
      command,
      args,
      exitCode: 0,
      stdout: "{}",
      stderr: "",
    });

    await expect(
      searchVideos("test query", 1, { runner }),
    ).rejects.toMatchObject({
      name: "ExternalToolError",
      kind: "invalid-output",
      stderr: "yt-dlp 搜索响应缺少 entries 数组。",
    });
  });

  it("rejects malformed entries instead of silently dropping them", async () => {
    const runner = async (
      command: string,
      args: string[],
    ): Promise<CommandResult> => ({
      command,
      args,
      exitCode: 0,
      stdout: JSON.stringify({ entries: [null] }),
      stderr: "",
    });

    await expect(
      searchVideos("test query", 1, { runner }),
    ).rejects.toMatchObject({
      name: "ExternalToolError",
      kind: "invalid-output",
      stderr: "yt-dlp 搜索响应包含无效条目。",
    });
  });

  it("rejects a search entry that omits its required identity fields", async () => {
    const runner = async (
      command: string,
      args: string[],
    ): Promise<CommandResult> => ({
      command,
      args,
      exitCode: 0,
      stdout: JSON.stringify({ entries: [{}] }),
      stderr: "",
    });

    await expect(
      searchVideos("test query", 1, { runner }),
    ).rejects.toMatchObject({
      name: "ExternalToolError",
      kind: "invalid-output",
      stderr: "yt-dlp 搜索响应条目缺少 id、title 或 URL。",
    });
  });

  it("keeps optional search metadata nullable when identity fields are present", async () => {
    const runner = async (
      command: string,
      args: string[],
    ): Promise<CommandResult> => ({
      command,
      args,
      exitCode: 0,
      stdout: JSON.stringify({
        entries: [
          {
            id: "dQw4w9WgXcQ",
            title: "Example",
            webpage_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          },
        ],
      }),
      stderr: "",
    });

    await expect(searchVideos("test query", 1, { runner })).resolves.toEqual([
      {
        id: "dQw4w9WgXcQ",
        title: "Example",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        channel: null,
        durationSeconds: null,
        viewCount: null,
        uploadDate: null,
        thumbnail: null,
      },
    ]);
  });

  it("preserves a legitimate empty search result", async () => {
    const runner = async (
      command: string,
      args: string[],
    ): Promise<CommandResult> => ({
      command,
      args,
      exitCode: 0,
      stdout: JSON.stringify({ entries: [] }),
      stderr: "",
    });

    await expect(searchVideos("test query", 1, { runner })).resolves.toEqual(
      [],
    );
  });
});

describe("public video inspection contract", () => {
  it("returns stable video details from a controlled yt-dlp runner", async () => {
    const runner = async (
      command: string,
      args: string[],
    ): Promise<CommandResult> => ({
      command,
      args,
      exitCode: 0,
      stdout: JSON.stringify({
        id: "dQw4w9WgXcQ",
        title: "Example",
        webpage_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        description: "Example description",
      }),
      stderr: "",
    });

    await expect(
      inspectVideo("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
        runner,
      }),
    ).resolves.toMatchObject({
      id: "dQw4w9WgXcQ",
      title: "Example",
      description: "Example description",
    });
  });

  it("rejects a JSON value that is not a video object", async () => {
    const runner = async (
      command: string,
      args: string[],
    ): Promise<CommandResult> => ({
      command,
      args,
      exitCode: 0,
      stdout: "[]",
      stderr: "",
    });

    await expect(
      inspectVideo("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
        runner,
      }),
    ).rejects.toMatchObject({
      name: "ExternalToolError",
      kind: "invalid-output",
      stderr: "yt-dlp JSON 响应必须是对象。",
    });
  });

  it("rejects video details that omit required identity fields", async () => {
    const runner = async (
      command: string,
      args: string[],
    ): Promise<CommandResult> => ({
      command,
      args,
      exitCode: 0,
      stdout: "{}",
      stderr: "",
    });

    await expect(
      inspectVideo("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
        runner,
      }),
    ).rejects.toMatchObject({
      name: "ExternalToolError",
      kind: "invalid-output",
      stderr: "yt-dlp 视频响应缺少 id、title 或 URL。",
    });
  });
});

describe("public caption inspection contract", () => {
  it("returns manual and automatic languages from a controlled runner", async () => {
    const runner = async (
      command: string,
      args: string[],
    ): Promise<CommandResult> => ({
      command,
      args,
      exitCode: 0,
      stdout: JSON.stringify({
        subtitles: { en: [{ ext: "vtt" }] },
        automatic_captions: { "zh-Hans": [{ ext: "vtt" }] },
      }),
      stderr: "",
    });

    await expect(
      listCaptionLanguages("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
        runner,
      }),
    ).resolves.toEqual({
      manual: ["en"],
      automatic: ["zh-Hans"],
    });
  });

  it("rejects a caption response that omits language collections", async () => {
    const runner = async (
      command: string,
      args: string[],
    ): Promise<CommandResult> => ({
      command,
      args,
      exitCode: 0,
      stdout: "{}",
      stderr: "",
    });

    await expect(
      listCaptionLanguages("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
        runner,
      }),
    ).rejects.toMatchObject({
      name: "ExternalToolError",
      kind: "invalid-output",
      stderr: "yt-dlp 字幕响应缺少语言集合。",
    });
  });
});
