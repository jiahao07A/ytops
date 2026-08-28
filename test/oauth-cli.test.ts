import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function runCli(args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync(
    process.execPath,
    [resolve(process.cwd(), "dist", "cli.js"), ...args],
    { encoding: "utf8", env },
  );
}

function withConfig(run: (configPath: string) => void): void {
  const configPath = resolve(tmpdir(), `ytops-oauth-cli-${randomUUID()}.json`);
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
    if (existsSync(configPath)) {
      unlinkSync(configPath);
    }
  }
}

describe("CLI 频道 OAuth 接入", () => {
  it("在没有授权状态时返回可查询的空接入状态", () => {
    withConfig((configPath) => {
      const result = runCli([
        "--json",
        "ops",
        "channel",
        "status",
        "--config",
        configPath,
      ]);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        data: {
          status: "not-connected",
          availableChannels: [],
          selectionRequired: false,
          connections: [],
        },
      });
    });
  });

  it("授权启动缺少客户端 ID 时返回安全错误且不要求输入客户端秘密", () => {
    withConfig((configPath) => {
      const env = { ...process.env };
      delete env.YTOPS_GOOGLE_CLIENT_ID;
      delete env.YTOPS_GOOGLE_CLIENT_SECRET;
      const result = runCli(
        ["--json", "ops", "channel", "auth-start", "--config", configPath],
        env,
      );

      expect(result.status).toBeGreaterThan(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: {
          code: "USER_INPUT",
          message: expect.stringContaining("客户端 ID"),
        },
      });
      expect(result.stdout).not.toContain("客户端秘密");
    });
  });

  it("授权启动返回只读授权地址且不回显客户端秘密", () => {
    withConfig((configPath) => {
      const clientSecret = "client-secret-must-not-leak";
      const result = runCli(
        ["--json", "ops", "channel", "auth-start", "--config", configPath],
        {
          ...process.env,
          YTOPS_GOOGLE_CLIENT_ID: "client-id",
          YTOPS_GOOGLE_CLIENT_SECRET: clientSecret,
        },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("youtube.readonly");
      expect(result.stdout).not.toContain(clientSecret);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        data: {
          selectionRequired: true,
          scopes: ["https://www.googleapis.com/auth/youtube.readonly"],
        },
      });
    });
  });

  it("只有显式 --comments 时才申请评论读取 scope", () => {
    withConfig((configPath) => {
      const result = runCli(
        [
          "--json",
          "ops",
          "channel",
          "auth-start",
          "--config",
          configPath,
          "--comments",
        ],
        {
          ...process.env,
          YTOPS_GOOGLE_CLIENT_ID: "client-id",
        },
      );

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        data: {
          scopes: [
            "https://www.googleapis.com/auth/youtube.readonly",
            "https://www.googleapis.com/auth/youtube.force-ssl",
          ],
        },
      });
    });
  });

  it("授权完成失败时不回显授权码、state 或客户端秘密", () => {
    withConfig((configPath) => {
      const authorizationCode = "authorization-code-must-not-leak";
      const oauthState = "oauth-state-must-not-leak";
      const clientSecret = "client-secret-must-not-leak";
      const result = runCli(
        [
          "--json",
          "ops",
          "channel",
          "auth-complete",
          "--config",
          configPath,
          "--code",
          authorizationCode,
          "--state",
          oauthState,
        ],
        {
          ...process.env,
          YTOPS_GOOGLE_CLIENT_SECRET: clientSecret,
        },
      );

      expect(result.status).toBeGreaterThan(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: {
          code: "USER_INPUT",
        },
      });
      expect(result.stdout).not.toContain(authorizationCode);
      expect(result.stdout).not.toContain(oauthState);
      expect(result.stdout).not.toContain(clientSecret);
    });
  });
});
