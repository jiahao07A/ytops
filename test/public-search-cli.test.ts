import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
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
  const directory = join(tmpdir(), `ytops-fake-ytdlp-${randomUUID()}`);
  const scriptPath = join(directory, "fake-yt-dlp.mjs");
  const executablePath = join(
    directory,
    process.platform === "win32" ? "yt-dlp.cmd" : "yt-dlp",
  );

  mkdirSync(directory);
  writeFileSync(
    scriptPath,
    [
      'const scenario = process.env.YTOPS_FAKE_YTDLP_SCENARIO ?? "success";',
      'if (scenario === "success") {',
      "  console.log(JSON.stringify({ entries: [{",
      '    id: "dQw4w9WgXcQ",',
      '    title: "Example",',
      '    webpage_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",',
      '    channel: "Example channel",',
      "    duration: 42,",
      "    view_count: 1000,",
      '    upload_date: "20260816",',
      '    thumbnail: "https://img.example/thumbnail.jpg"',
      "  }] }));",
      '} else if (scenario === "empty") {',
      '  console.log("{\\"entries\\":[]}");',
      '} else if (scenario === "malformed") {',
      '  process.stdout.write("not-json");',
      '} else if (scenario === "invalid") {',
      '  console.log("{}");',
      '} else if (scenario === "non-zero") {',
      '  process.stderr.write("private upstream diagnostic");',
      "  process.exitCode = 7;",
      "}",
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

  return {
    directory,
    files: [scriptPath, executablePath],
    env: {
      ...process.env,
      PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
    },
  };
}

function cleanupFakeYtDlp(fake: FakeYtDlp): void {
  for (const file of fake.files) {
    if (existsSync(file)) {
      unlinkSync(file);
    }
  }
  if (existsSync(fake.directory)) {
    rmdirSync(fake.directory);
  }
}

describe("public search CLI JSON contract", () => {
  let fake: FakeYtDlp;

  beforeAll(() => {
    fake = createFakeYtDlp();
  });

  afterAll(() => {
    cleanupFakeYtDlp(fake);
  });

  it.each([
    ["success", 1],
    ["empty", 0],
  ])("returns one JSON payload for %s results", (scenario, videoCount) => {
    const result = runCli(["--json", "search", "example"], {
      ...fake.env,
      YTOPS_FAKE_YTDLP_SCENARIO: scenario,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: {
        query: "example",
        videos: expect.any(Array),
      },
    });
    expect(JSON.parse(result.stdout).data.videos).toHaveLength(videoCount);
  });

  it.each([
    ["malformed", "EXTERNAL_RESPONSE_MALFORMED"],
    ["invalid", "EXTERNAL_RESPONSE_INVALID"],
    ["non-zero", "EXTERNAL_COMMAND_FAILED"],
  ])("maps %s failures to %s", (scenario, expectedCode) => {
    const result = runCli(["--json", "search", "example"], {
      ...fake.env,
      YTOPS_FAKE_YTDLP_SCENARIO: scenario,
    });

    expect(result.status).toBeGreaterThan(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        code: expectedCode,
        message: expect.any(String),
      },
    });
    expect(result.stdout).not.toContain("private upstream diagnostic");
  });
});
