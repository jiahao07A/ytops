import { mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "../src/lib/doctor.js";
import {
  initializeChannelOperationsConfig,
  updateGlobalChannelOperationsConfig,
} from "../src/lib/config.js";
import type { CommandResult } from "../src/lib/process.js";

describe("external tool diagnostics", () => {
  it("reports a missing command separately from healthy tools", async () => {
    const runner = async (
      command: string,
      args: string[],
    ): Promise<CommandResult> => {
      if (command === "yt-dlp") {
        throw Object.assign(new Error("spawn yt-dlp ENOENT"), {
          code: "ENOENT",
        });
      }

      return {
        command,
        args,
        exitCode: 0,
        stdout: `${command} 1.0.0`,
        stderr: "",
      };
    };

    const report = await runDoctor({ runner });

    expect(report.tools.find((tool) => tool.name === "yt-dlp")).toEqual({
      name: "yt-dlp",
      required: true,
      available: false,
      version: null,
      detail: "未在 PATH 中找到命令。",
      failure: {
        kind: "missing",
        exitCode: null,
        detail: "未在 PATH 中找到命令。",
      },
    });
    expect(report.tools.find((tool) => tool.name === "ffmpeg")).toMatchObject({
      available: true,
      failure: null,
    });
  });

  it("reports a non-zero exit without exposing command stderr", async () => {
    const secret = "cookie=do-not-echo";
    const runner = async (
      command: string,
      args: string[],
    ): Promise<CommandResult> => ({
      command,
      args,
      exitCode: 9,
      stdout: "",
      stderr: secret,
    });

    const report = await runDoctor({ runner });

    expect(report.tools[0]).toMatchObject({
      available: false,
      detail: "命令以退出码 9 结束。",
      failure: {
        kind: "non-zero-exit",
        exitCode: 9,
        detail: "命令以退出码 9 结束。",
      },
    });
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("reports an empty version response as malformed output", async () => {
    const runner = async (
      command: string,
      args: string[],
    ): Promise<CommandResult> => ({
      command,
      args,
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    const report = await runDoctor({ runner });

    expect(report.tools[0]).toMatchObject({
      available: false,
      version: null,
      detail: "命令未返回可识别的版本信息。",
      failure: {
        kind: "malformed-output",
        exitCode: 0,
        detail: "命令未返回可识别的版本信息。",
      },
    });
  });

  it("forces yt-dlp to ignore user configuration during diagnostics", async () => {
    const calls: Array<{
      command: string;
      args: string[];
      env?: NodeJS.ProcessEnv;
    }> = [];
    const runner = async (
      command: string,
      args: string[],
      options?: { env?: NodeJS.ProcessEnv },
    ): Promise<CommandResult> => {
      calls.push({ command, args, env: options?.env });
      return {
        command,
        args,
        exitCode: 0,
        stdout: `${command} 1.0.0`,
        stderr: "",
      };
    };

    await runDoctor({ runner });

    const ytDlpCall = calls.find((call) => call.command === "yt-dlp");
    expect(ytDlpCall?.args).toContain("--ignore-config");
    expect(ytDlpCall?.env?.YTDLP_IGNORE_CONFIG).toBe("1");
  });
});

describe("cookie access defaults", () => {
  const healthyRunner = async (
    command: string,
    args: string[],
  ): Promise<CommandResult> => ({
    command,
    args,
    exitCode: 0,
    stdout: `${command} 1.0.0`,
    stderr: "",
  });

  it("keeps cookie access disabled when no cookie source is configured", async () => {
    const originalFile = process.env.YTOPS_YTDLP_COOKIES_FILE;
    const originalBrowser = process.env.YTOPS_YTDLP_COOKIES_FROM_BROWSER;
    delete process.env.YTOPS_YTDLP_COOKIES_FILE;
    delete process.env.YTOPS_YTDLP_COOKIES_FROM_BROWSER;

    try {
      const report = await runDoctor({ runner: healthyRunner });
      expect(report.safeDefaults.cookieAccess).toBe("disabled");
    } finally {
      if (originalFile !== undefined) {
        process.env.YTOPS_YTDLP_COOKIES_FILE = originalFile;
      }
      if (originalBrowser !== undefined) {
        process.env.YTOPS_YTDLP_COOKIES_FROM_BROWSER = originalBrowser;
      }
    }
  });

  it("reports environment opt-in without exposing the cookie path", async () => {
    const cookiePath = "D:/private/ytops-cookies.txt";
    const originalFile = process.env.YTOPS_YTDLP_COOKIES_FILE;
    process.env.YTOPS_YTDLP_COOKIES_FILE = cookiePath;

    try {
      const report = await runDoctor({ runner: healthyRunner });
      expect(report.safeDefaults.cookieAccess).toBe("environment-opt-in");
      expect(JSON.stringify(report)).not.toContain(cookiePath);
    } finally {
      if (originalFile !== undefined) {
        process.env.YTOPS_YTDLP_COOKIES_FILE = originalFile;
      } else {
        delete process.env.YTOPS_YTDLP_COOKIES_FILE;
      }
    }
  });
});

describe("revenue opt-in status", () => {
  it("未提供运营配置时报告 not-configured", async () => {
    const report = await runDoctor();
    expect(report.safeDefaults.analyticsRevenueOptIn).toBe("not-configured");
  });

  it("配置显式 opt-in 后报告 opted-in，只报状态不报值", async () => {
    const root = await mkdtemp(join(tmpdir(), "ytops-doctor-"));
    const configPath = join(root, "config.json");
    try {
      await initializeChannelOperationsConfig(configPath, false);
      await updateGlobalChannelOperationsConfig(configPath, {
        analytics: { revenueOptIn: true },
      });
      const report = await runDoctor({ operationsConfigPath: configPath });
      expect(report.safeDefaults.analyticsRevenueOptIn).toBe("opted-in");
      expect(JSON.stringify(report)).not.toContain('"revenueOptIn"');
    } finally {
      await unlink(configPath).catch(() => undefined);
      await rmdir(root).catch(() => undefined);
    }
  });
});
