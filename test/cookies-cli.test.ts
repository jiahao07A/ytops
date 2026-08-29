import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface FakeYtDlp {
  directory: string;
  files: string[];
  env: NodeJS.ProcessEnv;
}

function runCli(args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync(
    process.execPath,
    [resolve(process.cwd(), "dist", "cli.js"), ...args],
    {
      encoding: "utf8",
      env,
    },
  );
}

function createFakeYtDlp(): FakeYtDlp {
  const directory = join(tmpdir(), `ytops-cookie-fake-${randomUUID()}`);
  const scriptPath = join(directory, "fake-yt-dlp.mjs");
  const executablePath = join(
    directory,
    process.platform === "win32" ? "yt-dlp.cmd" : "yt-dlp",
  );

  mkdirSync(directory);
  writeFileSync(
    scriptPath,
    [
      'import { writeFileSync } from "node:fs";',
      "if (process.env.YTOPS_FAKE_YTDLP_ARGS_FILE) {",
      "  writeFileSync(",
      "    process.env.YTOPS_FAKE_YTDLP_ARGS_FILE,",
      "    JSON.stringify(process.argv.slice(2)),",
      '    "utf8",',
      "  );",
      "}",
      'const isSearch = process.argv.slice(2).some((arg) => arg.startsWith("ytsearch"));',
      'const video = { id: "dQw4w9WgXcQ", title: "Example", webpage_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" };',
      "console.log(JSON.stringify(isSearch ? { entries: [video] } : video));",
    ].join("\n"),
    "utf8",
  );

  if (process.platform === "win32") {
    writeFileSync(
      executablePath,
      `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
      "utf8",
    );
  } else {
    writeFileSync(
      executablePath,
      `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`,
      "utf8",
    );
    chmodSync(executablePath, 0o755);
  }

  // 隔离宿主 shell 可能配置的 cookie 来源，需要它们的用例显式传入。
  const environment = { ...process.env };
  delete environment.YTOPS_YTDLP_COOKIES_FILE;
  delete environment.YTOPS_YTDLP_COOKIES_FROM_BROWSER;

  return {
    directory,
    files: [scriptPath, executablePath],
    env: {
      ...environment,
      PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
    },
  };
}

function cleanupFakeYtDlp(fake: FakeYtDlp): void {
  rmSync(fake.directory, { recursive: true, force: true });
}

describe("public retrieval cookie CLI contract", () => {
  let fake: FakeYtDlp;
  let workDirectory: string;
  let cookieFilePath: string;
  let argsFilePath: string;

  const runSearchWithCookies = (
    extraArgs: string[],
    env?: NodeJS.ProcessEnv,
  ) => {
    const result = runCli(
      ["--json", "search", "example", ...extraArgs],
      env ?? fake.env,
    );
    return result;
  };

  const receivedArguments = (): string[] => {
    return JSON.parse(readFileSync(argsFilePath, "utf8")) as string[];
  };

  const resetReceivedArgs = (): void => {
    rmSync(argsFilePath, { force: true });
  };

  const runSearchExpectingArgs = (
    extraArgs: string[],
    env: NodeJS.ProcessEnv,
  ) => {
    resetReceivedArgs();
    return runSearchWithCookies(extraArgs, env);
  };

  beforeAll(() => {
    fake = createFakeYtDlp();
    workDirectory = join(tmpdir(), `ytops-cookie-test-${randomUUID()}`);
    mkdirSync(workDirectory, { recursive: true });
    cookieFilePath = join(workDirectory, "cookies.txt");
    writeFileSync(cookieFilePath, "# Netscape HTTP Cookie File\n", "utf8");
    argsFilePath = join(workDirectory, "received-args.json");
  });

  afterAll(() => {
    cleanupFakeYtDlp(fake);
    rmSync(workDirectory, { recursive: true, force: true });
  });

  it("passes an explicit cookie file to yt-dlp", () => {
    const result = runSearchExpectingArgs(["--cookies", cookieFilePath], {
      ...fake.env,
      YTOPS_FAKE_YTDLP_ARGS_FILE: argsFilePath,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const received = receivedArguments();
    expect(received).toContain("--ignore-config");
    const cookieIndex = received.indexOf("--cookies");
    expect(cookieIndex).toBeGreaterThan(-1);
    expect(received[cookieIndex + 1]).toBe(cookieFilePath);
  });

  it("falls back to the cookies environment variables", () => {
    const result = runSearchExpectingArgs([], {
      ...fake.env,
      YTOPS_FAKE_YTDLP_ARGS_FILE: argsFilePath,
      YTOPS_YTDLP_COOKIES_FROM_BROWSER: "firefox",
    });

    expect(result.status).toBe(0);
    const received = receivedArguments();
    const browserIndex = received.indexOf("--cookies-from-browser");
    expect(browserIndex).toBeGreaterThan(-1);
    expect(received[browserIndex + 1]).toBe("firefox");
  });

  it("lets the command-line flag override the environment variable", () => {
    const result = runSearchExpectingArgs(["--cookies", cookieFilePath], {
      ...fake.env,
      YTOPS_FAKE_YTDLP_ARGS_FILE: argsFilePath,
      YTOPS_YTDLP_COOKIES_FILE: join(workDirectory, "ignored.txt"),
    });

    expect(result.status).toBe(0);
    const received = receivedArguments();
    expect(received[received.indexOf("--cookies") + 1]).toBe(cookieFilePath);
  });

  it("rejects a cookie file that does not exist without launching yt-dlp", () => {
    resetReceivedArgs();
    const result = runSearchWithCookies(
      ["--cookies", join(workDirectory, "missing.txt")],
      { ...fake.env, YTOPS_FAKE_YTDLP_ARGS_FILE: argsFilePath },
    );

    expect(result.status).toBeGreaterThan(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "USER_INPUT" },
    });
    expect(result.stdout).toContain("cookie 文件不存在");
    expect(existsSync(argsFilePath)).toBe(false);
  });

  it("rejects unsupported browsers before launching yt-dlp", () => {
    const result = runSearchWithCookies(["--cookies-from-browser", "safari18"]);

    expect(result.status).toBeGreaterThan(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "USER_INPUT" },
    });
    expect(result.stdout).toContain("只支持");
  });

  it("reports both conflicting sources across mechanisms", () => {
    const result = runSearchWithCookies(["--cookies", cookieFilePath], {
      ...fake.env,
      YTOPS_YTDLP_COOKIES_FROM_BROWSER: "firefox",
    });

    expect(result.status).toBeGreaterThan(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({ ok: false, error: { code: "USER_INPUT" } });
    expect(payload.error.message).toContain("--cookies");
    expect(payload.error.message).toContain("YTOPS_YTDLP_COOKIES_FROM_BROWSER");
  });

  it("resolves global.cookies from an explicit ops config as the lowest priority", () => {
    const configPath = join(workDirectory, "ops-config.json");
    const config = {
      version: 1,
      global: {
        dataDirectory: ".ytops-data",
        sync: {
          frequencyHours: 24,
          maxConcurrency: 1,
          quotaBudget: 10000,
          initialBackfillDays: 365,
        },
        cookies: { file: cookieFilePath },
        rawEvidenceRetentionDays: 365,
      },
      channels: [],
      analysisProfiles: {
        corePerformance: {
          metrics: ["views"],
          dimensions: ["day"],
          dateRange: "last-28-days",
          filters: {},
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(config), "utf8");

    const fromConfig = runSearchExpectingArgs(["--config", configPath], {
      ...fake.env,
      YTOPS_FAKE_YTDLP_ARGS_FILE: argsFilePath,
    });
    expect(fromConfig.status).toBe(0);
    expect(
      receivedArguments()[receivedArguments().indexOf("--cookies") + 1],
    ).toBe(cookieFilePath);
  });

  it("rejects a config file source conflicting with a command-line browser source", () => {
    const configPath = join(workDirectory, "ops-config-conflict.json");
    const config = {
      version: 1,
      global: {
        dataDirectory: ".ytops-data",
        sync: {
          frequencyHours: 24,
          maxConcurrency: 1,
          quotaBudget: 10000,
          initialBackfillDays: 365,
        },
        cookies: { file: cookieFilePath },
        rawEvidenceRetentionDays: 365,
      },
      channels: [],
      analysisProfiles: {
        corePerformance: {
          metrics: ["views"],
          dimensions: ["day"],
          dateRange: "last-28-days",
          filters: {},
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(config), "utf8");

    const result = runSearchWithCookies([
      "--config",
      configPath,
      "--cookies-from-browser",
      "edge",
    ]);

    expect(result.status).toBeGreaterThan(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({ ok: false, error: { code: "USER_INPUT" } });
    expect(payload.error.message).toContain("--cookies-from-browser");
    expect(payload.error.message).toContain("global.cookies.file");
  });

  it("rejects a config that sets both cookie sources", () => {
    const configPath = join(workDirectory, "invalid-cookies-config.json");
    const config = {
      version: 1,
      global: {
        dataDirectory: ".ytops-data",
        sync: {
          frequencyHours: 24,
          maxConcurrency: 1,
          quotaBudget: 10000,
          initialBackfillDays: 365,
        },
        cookies: { file: cookieFilePath, fromBrowser: "firefox" },
        rawEvidenceRetentionDays: 365,
      },
      channels: [],
      analysisProfiles: {
        corePerformance: {
          metrics: ["views"],
          dimensions: ["day"],
          dateRange: "last-28-days",
          filters: {},
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(config), "utf8");

    const result = runSearchWithCookies(["--config", configPath]);

    expect(result.status).toBeGreaterThan(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "USER_INPUT" },
    });
    expect(result.stdout).toContain("只能配置其中一种来源");
  });

  it("forwards cookies for authorized download commands", () => {
    resetReceivedArgs();
    const result = runCli(
      [
        "--json",
        "download",
        "audio",
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "--output-dir",
        workDirectory,
        "--rights-confirmed",
        "--cookies",
        cookieFilePath,
      ],
      { ...fake.env, YTOPS_FAKE_YTDLP_ARGS_FILE: argsFilePath },
    );

    expect(result.status).toBe(0);
    const received = receivedArguments();
    expect(received).toContain("--ignore-config");
    expect(received[received.indexOf("--cookies") + 1]).toBe(cookieFilePath);
  });

  it("forwards cookies for inspect and captions fetch commands", () => {
    resetReceivedArgs();
    const inspected = runCli(
      [
        "--json",
        "inspect",
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "--cookies-from-browser",
        "firefox",
      ],
      { ...fake.env, YTOPS_FAKE_YTDLP_ARGS_FILE: argsFilePath },
    );
    expect(inspected.status).toBe(0);
    const inspectArgs = receivedArguments();
    expect(inspectArgs[inspectArgs.indexOf("--cookies-from-browser") + 1]).toBe(
      "firefox",
    );

    resetReceivedArgs();
    const captions = runCli(
      [
        "--json",
        "captions",
        "fetch",
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "--language",
        "en",
        "--output-dir",
        workDirectory,
        "--rights-confirmed",
        "--cookies",
        cookieFilePath,
      ],
      { ...fake.env, YTOPS_FAKE_YTDLP_ARGS_FILE: argsFilePath },
    );
    expect(captions.status).toBe(0);
    const captionsArgs = receivedArguments();
    expect(captionsArgs).toContain("--ignore-config");
    expect(captionsArgs[captionsArgs.indexOf("--cookies") + 1]).toBe(
      cookieFilePath,
    );
  });

  it("applies config cookie overrides temporarily without persisting them", () => {
    const configPath = join(workDirectory, "ops-config-temp.json");
    const config = {
      version: 1,
      global: {
        dataDirectory: ".ytops-data",
        sync: {
          frequencyHours: 24,
          maxConcurrency: 1,
          quotaBudget: 10000,
          initialBackfillDays: 365,
        },
        rawEvidenceRetentionDays: 365,
      },
      channels: [],
      analysisProfiles: {
        corePerformance: {
          metrics: ["views"],
          dimensions: ["day"],
          dateRange: "last-28-days",
          filters: {},
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(config), "utf8");

    const result = runCli(
      [
        "--json",
        "config",
        "validate",
        "--config",
        configPath,
        "--cookies-from-browser",
        "firefox",
      ],
      fake.env,
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: {
        valid: true,
        config: { global: { cookies: { fromBrowser: "firefox" } } },
      },
    });
    expect(readFileSync(configPath, "utf8")).toBe(JSON.stringify(config));
  });

  it("rejects both config cookie flags and clears persisted cookies with an empty value", () => {
    const configPath = join(workDirectory, "ops-config-cli.json");
    const config = {
      version: 1,
      global: {
        dataDirectory: ".ytops-data",
        sync: {
          frequencyHours: 24,
          maxConcurrency: 1,
          quotaBudget: 10000,
          initialBackfillDays: 365,
        },
        cookies: { file: cookieFilePath },
        rawEvidenceRetentionDays: 365,
      },
      channels: [],
      analysisProfiles: {
        corePerformance: {
          metrics: ["views"],
          dimensions: ["day"],
          dateRange: "last-28-days",
          filters: {},
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(config), "utf8");

    const bothFlags = runCli(
      [
        "--json",
        "config",
        "set-global",
        "--config",
        configPath,
        "--cookies-file",
        cookieFilePath,
        "--cookies-from-browser",
        "firefox",
      ],
      fake.env,
    );
    expect(bothFlags.status).toBeGreaterThan(0);
    expect(JSON.parse(bothFlags.stdout)).toMatchObject({
      ok: false,
      error: { code: "USER_INPUT" },
    });
    expect(readFileSync(configPath, "utf8")).toBe(JSON.stringify(config));

    const cleared = runCli(
      [
        "--json",
        "config",
        "set-global",
        "--config",
        configPath,
        "--cookies-file",
        "",
      ],
      fake.env,
    );
    expect(cleared.status).toBe(0);
    const persisted = JSON.parse(readFileSync(configPath, "utf8")) as {
      global: { cookies?: unknown };
    };
    expect(persisted.global.cookies).toBeUndefined();
  });

  it("reports cookie environment booleans in ops doctor without values", () => {
    const result = runCli(["--json", "ops", "doctor"], {
      ...fake.env,
      YTOPS_YTDLP_COOKIES_FILE: cookieFilePath,
    });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      data: Record<string, unknown>;
    };
    expect(payload.data.cookiesFileConfigured).toBe(true);
    expect(payload.data.cookiesFromBrowserConfigured).toBe(false);
    const safeDefaults = payload.data.safeDefaults as Record<string, string>;
    expect(safeDefaults.cookieAccess).toBe("environment-opt-in");
    expect(result.stdout).not.toContain(cookieFilePath);
  });
});
