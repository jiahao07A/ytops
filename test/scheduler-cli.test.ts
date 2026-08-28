import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

function runCli(args: string[]) {
  return spawnSync(
    process.execPath,
    [join(process.cwd(), "dist", "cli.js"), ...args],
    { encoding: "utf8" },
  );
}

function withConfig(run: (configPath: string) => void): void {
  const configPath = join(tmpdir(), `ytops-scheduler-cli-${randomUUID()}.json`);
  const statePath = `${configPath}.scheduler.json`;
  try {
    const initialized = runCli([
      "--json",
      "config",
      "init",
      "--output",
      configPath,
    ]);
    expect(initialized.status).toBe(0);
    run(configPath);
  } finally {
    for (const path of [configPath, statePath]) {
      if (existsSync(path)) unlinkSync(path);
    }
  }
}

function expectJson(result: ReturnType<typeof runCli>) {
  expect(result.stderr).toBe("");
  expect(() => JSON.parse(result.stdout)).not.toThrow();
  return JSON.parse(result.stdout) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: Record<string, unknown>;
  };
}

describe("scheduler CLI JSON contract", () => {
  it("runs one scheduler cycle and returns a stable summary", () => {
    withConfig((configPath) => {
      const result = runCli([
        "--json",
        "ops",
        "channel",
        "scheduler",
        "run",
        "--config",
        configPath,
      ]);

      expect(result.status).toBe(0);
      expect(expectJson(result)).toMatchObject({
        ok: true,
        data: {
          configPath,
          tasks: [],
          summary: { total: 0, due: 0, succeeded: 0, failed: 0, skipped: 0 },
        },
      });
    });
  });

  it.each([
    ["run", ["run"]],
    ["install", ["install"]],
    ["status", ["status"]],
    ["disable", ["disable"]],
  ])("rejects %s when --config is missing", (_name, command) => {
    const result = runCli([
      "--json",
      "ops",
      "channel",
      "scheduler",
      ...command,
    ]);

    expect(result.status).toBeGreaterThan(0);
    expect(expectJson(result)).toMatchObject({
      ok: false,
      error: { code: expect.any(String), message: expect.any(String) },
    });
  });

  it("returns an explicit supportability error for task commands off Windows", () => {
    if (process.platform === "win32") return;

    withConfig((configPath) => {
      for (const command of ["install", "status", "disable"]) {
        const result = runCli([
          "--json",
          "ops",
          "channel",
          "scheduler",
          command,
          "--config",
          configPath,
        ]);
        expect(result.status).toBeGreaterThan(0);
        expect(expectJson(result)).toMatchObject({
          ok: false,
          error: {
            code: "USER_INPUT",
            message: expect.stringContaining("仅支持 Windows"),
          },
        });
      }
    });
  });

  it("previews, installs, reports, and idempotently disables the Windows task adapter", () => {
    if (process.platform !== "win32") return;

    withConfig((configPath) => {
      const preview = runCli([
        "--json",
        "ops",
        "channel",
        "scheduler",
        "install",
        "--config",
        configPath,
      ]);
      expect(preview.status).toBe(0);
      expect(expectJson(preview)).toMatchObject({
        ok: true,
        data: {
          supported: true,
          installed: false,
          changed: true,
          requiresConfirmation: true,
          taskName: "ytops-inventory-scheduler",
          frequencyHours: 24,
          command: expect.stringContaining("scheduler run"),
          workingDirectory: expect.any(String),
          impact: expect.any(String),
        },
      });

      const installed = runCli([
        "--json",
        "ops",
        "channel",
        "scheduler",
        "install",
        "--config",
        configPath,
        "--yes",
      ]);
      expect(installed.status).toBe(0);
      expect(expectJson(installed)).toMatchObject({
        ok: true,
        data: {
          supported: true,
          installed: true,
          changed: true,
          requiresConfirmation: false,
          state: { enabled: true, taskName: "ytops-inventory-scheduler" },
        },
      });

      const status = runCli([
        "--json",
        "ops",
        "channel",
        "scheduler",
        "status",
        "--config",
        configPath,
      ]);
      expect(status.status).toBe(0);
      expect(expectJson(status)).toMatchObject({
        ok: true,
        data: {
          supported: true,
          installed: true,
          drift: false,
          state: { enabled: true },
        },
      });

      const disabled = runCli([
        "--json",
        "ops",
        "channel",
        "scheduler",
        "disable",
        "--config",
        configPath,
        "--yes",
      ]);
      expect(disabled.status).toBe(0);
      expect(expectJson(disabled)).toMatchObject({
        ok: true,
        data: {
          supported: true,
          installed: false,
          changed: true,
          requiresConfirmation: false,
          state: { enabled: false },
        },
      });

      const disabledAgain = runCli([
        "--json",
        "ops",
        "channel",
        "scheduler",
        "disable",
        "--config",
        configPath,
        "--yes",
      ]);
      expect(disabledAgain.status).toBe(0);
      expect(expectJson(disabledAgain)).toMatchObject({
        ok: true,
        data: { installed: false, changed: false, requiresConfirmation: false },
      });

      expect(
        JSON.parse(readFileSync(`${configPath}.scheduler.json`, "utf8")),
      ).toMatchObject({
        enabled: false,
      });
    });
  });
});
