import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

const testChannelId = "UC1234567890123456789012";

function runCli(args: string[]) {
  return spawnSync(
    process.execPath,
    [resolve(process.cwd(), "dist", "cli.js"), ...args],
    {
      encoding: "utf8",
    },
  );
}

function withInitializedConfig(run: (configPath: string) => void): void {
  const configPath = resolve(tmpdir(), `ytops-config-${randomUUID()}.json`);

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

describe("CLI JSON error contract", () => {
  it.each([
    ["missing mandatory option", ["--json", "captions", "fetch"]],
    ["unknown option", ["--json", "--not-a-real-option"]],
  ])("serializes %s as a single JSON error payload", (_scenario, args) => {
    const result = runCli(args);

    expect(result.status).toBeGreaterThan(0);
    expect(result.stderr).toBe("");
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        code: expect.any(String),
        message: expect.any(String),
      },
    });
  });

  it.each([
    ["help", ["--json", "--help"], "Usage: ytops"],
    ["version", ["--json", "--version"], "0.1.0"],
  ])(
    "serializes %s output without mixing human-readable stdout",
    (_scenario, args, expectedOutput) => {
      const result = runCli(args);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        data: {
          output: expect.stringContaining(expectedOutput),
        },
      });
    },
  );
});

describe("频道运营配置", () => {
  it("initializes a non-sensitive three-layer configuration", () => {
    const configPath = resolve(tmpdir(), `ytops-config-${randomUUID()}.json`);

    try {
      const result = runCli([
        "--json",
        "config",
        "init",
        "--output",
        configPath,
      ]);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        data: {
          created: true,
          configPath,
        },
      });

      const config = JSON.parse(readFileSync(configPath, "utf8"));
      expect(config).toMatchObject({
        version: 1,
        global: {
          sync: {
            frequencyHours: 24,
            maxConcurrency: 1,
            quotaBudget: 10_000,
          },
        },
        channels: [],
        analysisProfiles: expect.any(Object),
      });
      expect(JSON.stringify(config)).not.toMatch(
        /token|secret|clientSecret|password|apiKey/i,
      );
    } finally {
      if (existsSync(configPath)) {
        unlinkSync(configPath);
      }
    }
  });

  it("does not overwrite an existing configuration without explicit consent", () => {
    const configPath = resolve(tmpdir(), `ytops-config-${randomUUID()}.json`);

    try {
      const initialized = runCli([
        "--json",
        "config",
        "init",
        "--output",
        configPath,
      ]);
      expect(initialized.status).toBe(0);
      const original = readFileSync(configPath, "utf8");

      const result = runCli([
        "--json",
        "config",
        "init",
        "--output",
        configPath,
      ]);

      expect(result.status).toBeGreaterThan(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: {
          code: "USER_INPUT",
          message: expect.stringContaining("已存在"),
        },
      });
      expect(readFileSync(configPath, "utf8")).toBe(original);
    } finally {
      if (existsSync(configPath)) {
        unlinkSync(configPath);
      }
    }
  });

  it("validates a persisted configuration", () => {
    const configPath = resolve(tmpdir(), `ytops-config-${randomUUID()}.json`);

    try {
      const initialized = runCli([
        "--json",
        "config",
        "init",
        "--output",
        configPath,
      ]);
      expect(initialized.status).toBe(0);

      const result = runCli([
        "--json",
        "config",
        "validate",
        "--config",
        configPath,
      ]);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        data: {
          valid: true,
          configPath,
          config: {
            version: 1,
            channels: [],
          },
        },
      });
    } finally {
      if (existsSync(configPath)) {
        unlinkSync(configPath);
      }
    }
  });

  it("hides credential-shaped configuration paths from successful output", () => {
    const credential = "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-secret";
    const configPath = resolve(tmpdir(), credential);

    try {
      const initialized = runCli([
        "--json",
        "config",
        "init",
        "--output",
        configPath,
      ]);
      expect(initialized.status).toBe(0);
      expect(initialized.stdout).not.toContain(credential);
      expect(JSON.parse(initialized.stdout)).toMatchObject({
        ok: true,
        data: { configPath: "<已隐藏的配置路径>" },
      });

      const validated = runCli([
        "--json",
        "config",
        "validate",
        "--config",
        configPath,
      ]);
      expect(validated.status).toBe(0);
      expect(validated.stdout).not.toContain(credential);
      expect(JSON.parse(validated.stdout)).toMatchObject({
        ok: true,
        data: { configPath: "<已隐藏的配置路径>" },
      });

      const updated = runCli([
        "--json",
        "config",
        "set-global",
        "--config",
        configPath,
        "--sync-frequency-hours",
        "12",
      ]);
      expect(updated.status).toBe(0);
      expect(updated.stdout).not.toContain(credential);
      expect(JSON.parse(updated.stdout)).toMatchObject({
        ok: true,
        data: { configPath: "<已隐藏的配置路径>" },
      });
    } finally {
      if (existsSync(configPath)) {
        unlinkSync(configPath);
      }
    }
  });

  it("hides credential-shaped configuration paths from I/O errors", () => {
    const credential =
      "cache+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ig-path-secret";
    const configPath = resolve(tmpdir(), credential);

    try {
      mkdirSync(configPath);
      const result = runCli([
        "--json",
        "config",
        "init",
        "--output",
        configPath,
        "--overwrite",
      ]);

      expect(result.status).toBeGreaterThan(0);
      expect(result.stdout).not.toContain(credential);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: {
          code: "UNEXPECTED",
          message: expect.stringContaining("敏感路径已隐藏"),
        },
      });
    } finally {
      if (existsSync(configPath)) {
        rmdirSync(configPath);
      }
    }
  });

  it("rejects protected credentials without echoing their values", () => {
    const configPath = resolve(tmpdir(), `ytops-config-${randomUUID()}.json`);
    const token = "do-not-echo-this-token";

    try {
      const initialized = runCli([
        "--json",
        "config",
        "init",
        "--output",
        configPath,
      ]);
      expect(initialized.status).toBe(0);

      const unsafeConfig = JSON.parse(readFileSync(configPath, "utf8"));
      unsafeConfig.token = token;
      writeFileSync(configPath, JSON.stringify(unsafeConfig), "utf8");

      const result = runCli([
        "--json",
        "config",
        "validate",
        "--config",
        configPath,
      ]);

      expect(result.status).toBeGreaterThan(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain(token);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: {
          code: "USER_INPUT",
          message: expect.stringContaining("配置格式无效"),
        },
      });
    } finally {
      if (existsSync(configPath)) {
        unlinkSync(configPath);
      }
    }
  });

  it.each([
    "safe/client.secret=opaque-oauth-secret",
    "safe/access.token=opaque-oauth-token",
  ])(
    "rejects dotted credential fields in data directories without echoing %s",
    (dataDirectory) => {
      withInitializedConfig((configPath) => {
        const result = runCli([
          "--json",
          "config",
          "validate",
          "--config",
          configPath,
          "--data-directory",
          dataDirectory,
        ]);

        expect(result.status).toBeGreaterThan(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).not.toContain(dataDirectory);
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: false,
          error: { code: "USER_INPUT" },
        });
      });
    },
  );

  it("rejects control characters in CLI analysis profile names", () => {
    withInitializedConfig((configPath) => {
      const result = runCli([
        "--json",
        "config",
        "validate",
        "--config",
        configPath,
        "--profile",
        "audit\nprofile",
        "--profile-metrics",
        "views",
        "--profile-dimensions",
        "day",
        "--profile-date-range",
        "last-7-days",
      ]);

      expect(result.status).toBeGreaterThan(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain("audit\nprofile");
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { code: "USER_INPUT" },
      });
    });
  });

  it("applies temporary sync overrides without changing the saved configuration", () => {
    const configPath = resolve(tmpdir(), `ytops-config-${randomUUID()}.json`);

    try {
      const initialized = runCli([
        "--json",
        "config",
        "init",
        "--output",
        configPath,
      ]);
      expect(initialized.status).toBe(0);

      const result = runCli([
        "--json",
        "config",
        "validate",
        "--config",
        configPath,
        "--sync-frequency-hours",
        "12",
      ]);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        data: {
          valid: true,
          config: {
            global: {
              sync: {
                frequencyHours: 12,
              },
            },
          },
        },
      });
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
        global: {
          sync: {
            frequencyHours: 24,
          },
        },
      });
    } finally {
      if (existsSync(configPath)) {
        unlinkSync(configPath);
      }
    }
  });

  it("persists explicit global configuration updates", () => {
    const configPath = resolve(tmpdir(), `ytops-config-${randomUUID()}.json`);

    try {
      const initialized = runCli([
        "--json",
        "config",
        "init",
        "--output",
        configPath,
      ]);
      expect(initialized.status).toBe(0);

      const result = runCli([
        "--json",
        "config",
        "set-global",
        "--config",
        configPath,
        "--sync-frequency-hours",
        "12",
      ]);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        data: {
          updated: true,
          configPath,
          config: {
            global: {
              sync: {
                frequencyHours: 12,
              },
            },
          },
        },
      });
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
        global: {
          sync: {
            frequencyHours: 12,
          },
        },
      });
      expect(
        readdirSync(tmpdir()).some((entry) =>
          entry.startsWith(`.${basename(configPath)}.`),
        ),
      ).toBe(false);
    } finally {
      if (existsSync(configPath)) {
        unlinkSync(configPath);
      }
    }
  });

  it("explains the three configuration layers without exposing credentials", () => {
    const result = runCli(["--json", "config", "explain"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: {
        global: expect.objectContaining({
          description: expect.any(String),
          options: expect.any(Array),
        }),
        channel: expect.objectContaining({
          description: expect.any(String),
          options: expect.any(Array),
        }),
        analysisProfile: expect.objectContaining({
          description: expect.any(String),
          options: expect.any(Array),
        }),
        credentialPolicy: expect.stringContaining("操作系统"),
      },
    });
    expect(result.stdout).not.toMatch(/clientSecret|accessToken|refreshToken/i);
  });
});

describe("三层配置合同", () => {
  it.each(["accessToken", "cookie"])(
    "拒绝嵌套凭据键 %s，且不会在 JSON 中回显凭据值",
    (credentialKey) => {
      const token = "do-not-echo-this-nested-token";

      withInitializedConfig((configPath) => {
        const unsafeConfig = JSON.parse(readFileSync(configPath, "utf8"));
        unsafeConfig.analysisProfiles.corePerformance.filters[credentialKey] =
          token;
        writeFileSync(configPath, JSON.stringify(unsafeConfig), "utf8");

        const result = runCli([
          "--json",
          "config",
          "validate",
          "--config",
          configPath,
        ]);

        expect(result.status).toBeGreaterThan(0);
        expect(result.stdout).not.toContain(token);
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: false,
          error: {
            code: "USER_INPUT",
            message: expect.stringContaining("受保护凭据"),
          },
        });
      });
    },
  );

  it("拒绝使用安全筛选键承载不受支持的长敏感值，且不回显该值", () => {
    const credential = "do-not-echo-this-opaque-filter-value";

    withInitializedConfig((configPath) => {
      const unsafeConfig = JSON.parse(readFileSync(configPath, "utf8"));
      unsafeConfig.analysisProfiles.corePerformance.filters.country =
        credential;
      writeFileSync(configPath, JSON.stringify(unsafeConfig), "utf8");

      const result = runCli([
        "--json",
        "config",
        "validate",
        "--config",
        configPath,
      ]);

      expect(result.status).toBeGreaterThan(0);
      expect(result.stdout).not.toContain(credential);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: {
          code: "USER_INPUT",
          message: expect.stringContaining("筛选值"),
        },
      });
    });
  });

  it("拒绝使用安全筛选键承载短秘密，且不回显该值", () => {
    const credential = "s3cr3t42";

    withInitializedConfig((configPath) => {
      const unsafeConfig = JSON.parse(readFileSync(configPath, "utf8"));
      unsafeConfig.analysisProfiles.corePerformance.filters.country =
        credential;
      writeFileSync(configPath, JSON.stringify(unsafeConfig), "utf8");

      const result = runCli([
        "--json",
        "config",
        "validate",
        "--config",
        configPath,
      ]);

      expect(result.status).toBeGreaterThan(0);
      expect(result.stdout).not.toContain(credential);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: {
          code: "USER_INPUT",
          message: expect.stringContaining("country"),
        },
      });
    });
  });

  it("拒绝 CLI 筛选值中的不透明敏感值，且不回显该值", () => {
    const credential = "do-not-echo-this-cli-filter-value";

    withInitializedConfig((configPath) => {
      const result = runCli([
        "--json",
        "config",
        "validate",
        "--config",
        configPath,
        "--profile",
        "corePerformance",
        "--profile-filter",
        `country=${credential}`,
      ]);

      expect(result.status).toBeGreaterThan(0);
      expect(result.stdout).not.toContain(credential);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: {
          code: "USER_INPUT",
          message: expect.stringContaining("筛选值"),
        },
      });
    });
  });

  it("拒绝 CLI 中安全筛选键承载短秘密，且不回显该值", () => {
    const credential = "s3cr3t42";

    withInitializedConfig((configPath) => {
      const result = runCli([
        "--json",
        "config",
        "validate",
        "--config",
        configPath,
        "--profile",
        "corePerformance",
        "--profile-filter",
        `country=${credential}`,
      ]);

      expect(result.status).toBeGreaterThan(0);
      expect(result.stdout).not.toContain(credential);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: {
          code: "USER_INPUT",
          message: expect.stringContaining("country"),
        },
      });
    });
  });

  it.each([
    ["分析指标", ["--profile", "corePerformance", "--profile-metrics"]],
    ["分析维度", ["--profile", "corePerformance", "--profile-dimensions"]],
    ["分析时间范围", ["--profile", "corePerformance", "--profile-date-range"]],
    ["本机数据目录", ["--data-directory"]],
  ])("拒绝 CLI %s 中的自由文本秘密，且不回显该值", (_label, args) => {
    const credential = "s3cr3t42";

    withInitializedConfig((configPath) => {
      const result = runCli([
        "--json",
        "config",
        "validate",
        "--config",
        configPath,
        ...args,
        credential,
      ]);

      expect(result.status).toBeGreaterThan(0);
      expect(result.stdout).not.toContain(credential);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { code: "USER_INPUT" },
      });
    });
  });

  it.each([
    "https://user:do-not-echo-this-url-secret@host/path",
    "./ya29.do-not-echo-this-oauth-token",
    "./1//do-not-echo-this-refresh-token",
  ])("拒绝带凭据的非本机数据目录 %s，且不回显其值", (dataDirectory) => {
    withInitializedConfig((configPath) => {
      const result = runCli([
        "--json",
        "config",
        "validate",
        "--config",
        configPath,
        "--data-directory",
        dataDirectory,
      ]);

      expect(result.status).toBeGreaterThan(0);
      expect(result.stdout).not.toContain(dataDirectory);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { code: "USER_INPUT" },
      });
    });
  });

  it("拒绝持久化带凭据的本机目录路径，且保留原配置", () => {
    const dataDirectory = "./cache+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et";

    withInitializedConfig((configPath) => {
      const savedConfig = readFileSync(configPath, "utf8");
      const result = runCli([
        "--json",
        "config",
        "set-global",
        "--config",
        configPath,
        "--data-directory",
        dataDirectory,
      ]);

      expect(result.status).toBeGreaterThan(0);
      expect(result.stdout).not.toContain(dataDirectory);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { code: "USER_INPUT" },
      });
      expect(readFileSync(configPath, "utf8")).toBe(savedConfig);
    });
  });

  it.each([
    "safe/1//do-not-echo-this-embedded-refresh-token",
    ".\\cache.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client-secret",
    "./cache+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-client-secret",
    "./safe+1//do-not-echo-this-plus-prefix-refresh-token",
    "./https://operator:do-not-echo-this-embedded-url-secret@example.invalid/data",
    "./?refresh_token=1//do-not-echo-this-query-refresh-token",
    "safe/client_secret=do-not-echo-this-path-client-secret",
    "safe/access_token=do-not-echo-this-path-access-token",
    "./cache+client_secret=do-not-echo-this-plus-prefix-client-secret",
    "./cache#access_token=do-not-echo-this-hash-prefix-access-token",
    "safe/-----BEGIN PRIVATE KEY-----\\nnot-a-real-private-key",
    "safe/client.secret=do-not-echo-this-dot-client-secret",
    "safe/access.token=do-not-echo-this-dot-access-token",
  ])("拒绝临时数据目录中嵌入的凭据形状 %s，且不回显其值", (dataDirectory) => {
    withInitializedConfig((configPath) => {
      const result = runCli([
        "--json",
        "config",
        "validate",
        "--config",
        configPath,
        "--data-directory",
        dataDirectory,
      ]);

      expect(result.status).toBeGreaterThan(0);
      expect(result.stdout).not.toContain(dataDirectory);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { code: "USER_INPUT" },
      });
    });
  });

  it("拒绝配置文件数据目录中嵌入的 OAuth 凭据，且不回显其值", () => {
    const credential = "do-not-echo-this-file-refresh-token";
    const dataDirectory = `safe/1//${credential}`;

    withInitializedConfig((configPath) => {
      const unsafeConfig = JSON.parse(readFileSync(configPath, "utf8"));
      unsafeConfig.global.dataDirectory = dataDirectory;
      writeFileSync(configPath, JSON.stringify(unsafeConfig), "utf8");

      const result = runCli([
        "--json",
        "config",
        "validate",
        "--config",
        configPath,
      ]);

      expect(result.status).toBeGreaterThan(0);
      expect(result.stdout).not.toContain(credential);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { code: "USER_INPUT" },
      });
    });
  });

  it("拒绝配置文件数据目录中含控制字符拆开的 OAuth 凭据", () => {
    const credential = "do-not-echo-this-control-character-oauth-token";
    const dataDirectory = `safe/\u0000ya29.${credential}`;

    withInitializedConfig((configPath) => {
      const unsafeConfig = JSON.parse(readFileSync(configPath, "utf8"));
      unsafeConfig.global.dataDirectory = dataDirectory;
      writeFileSync(configPath, JSON.stringify(unsafeConfig), "utf8");

      const result = runCli([
        "--json",
        "config",
        "validate",
        "--config",
        configPath,
      ]);

      expect(result.status).toBeGreaterThan(0);
      expect(result.stdout).not.toContain(credential);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { code: "USER_INPUT" },
      });
    });
  });

  it("拒绝持久化数据目录中嵌入的 URL 凭据，且保留原配置", () => {
    const credential = "do-not-echo-this-persistent-url-secret";
    const dataDirectory = `./https://operator:${credential}@example.invalid/data`;

    withInitializedConfig((configPath) => {
      const savedConfig = readFileSync(configPath, "utf8");
      const result = runCli([
        "--json",
        "config",
        "set-global",
        "--config",
        configPath,
        "--data-directory",
        dataDirectory,
      ]);

      expect(result.status).toBeGreaterThan(0);
      expect(result.stdout).not.toContain(credential);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { code: "USER_INPUT" },
      });
      expect(readFileSync(configPath, "utf8")).toBe(savedConfig);
    });
  });

  it("拒绝配置文件中的无效频道 ID，且不回显该值", () => {
    const credential = "s3cr3t42";

    withInitializedConfig((configPath) => {
      const unsafeConfig = JSON.parse(readFileSync(configPath, "utf8"));
      unsafeConfig.channels = [{ channelId: credential, enabled: true }];
      writeFileSync(configPath, JSON.stringify(unsafeConfig), "utf8");

      const result = runCli([
        "--json",
        "config",
        "validate",
        "--config",
        configPath,
      ]);

      expect(result.status).toBeGreaterThan(0);
      expect(result.stdout).not.toContain(credential);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { code: "USER_INPUT" },
      });
    });
  });

  it("将带空格的频道 ID 规范化为已有频道配置", () => {
    withInitializedConfig((configPath) => {
      const created = runCli([
        "--json",
        "config",
        "set-channel",
        "--config",
        configPath,
        "--channel",
        testChannelId,
        "--channel-enabled",
        "false",
      ]);
      expect(created.status).toBe(0);

      const updated = runCli([
        "--json",
        "config",
        "set-channel",
        "--config",
        configPath,
        "--channel",
        ` ${testChannelId} `,
        "--channel-enabled",
        "true",
      ]);

      expect(updated.status).toBe(0);
      expect(JSON.parse(updated.stdout)).toMatchObject({
        ok: true,
        data: {
          config: {
            channels: [{ channelId: testChannelId, enabled: true }],
          },
        },
      });
      expect(
        JSON.parse(readFileSync(configPath, "utf8")).channels,
      ).toHaveLength(1);
    });
  });

  it("将带空格的档案名规范化为已有分析档案", () => {
    withInitializedConfig((configPath) => {
      const result = runCli([
        "--json",
        "config",
        "set-profile",
        "--config",
        configPath,
        "--profile",
        " corePerformance ",
        "--profile-metrics",
        "views,likes",
      ]);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        data: {
          config: {
            analysisProfiles: {
              corePerformance: expect.objectContaining({
                metrics: ["views", "likes"],
              }),
            },
          },
        },
      });
      expect(
        JSON.parse(readFileSync(configPath, "utf8")).analysisProfiles,
      ).not.toHaveProperty(" corePerformance ");
    });
  });

  it("拒绝去除空格后与现有档案同名的配置文件键", () => {
    withInitializedConfig((configPath) => {
      const unsafeConfig = JSON.parse(readFileSync(configPath, "utf8"));
      unsafeConfig.analysisProfiles[" corePerformance "] = {
        ...unsafeConfig.analysisProfiles.corePerformance,
      };
      writeFileSync(configPath, JSON.stringify(unsafeConfig), "utf8");

      const result = runCli([
        "--json",
        "config",
        "validate",
        "--config",
        configPath,
      ]);

      expect(result.status).toBeGreaterThan(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: {
          code: "USER_INPUT",
          message: expect.stringContaining("去除首尾空格后不能重复"),
        },
      });
    });
  });

  it("拒绝去除空格后同名的分析筛选字段", () => {
    withInitializedConfig((configPath) => {
      const unsafeConfig = JSON.parse(readFileSync(configPath, "utf8"));
      unsafeConfig.analysisProfiles.corePerformance.filters = {
        country: "US",
        " country ": "CA",
      };
      writeFileSync(configPath, JSON.stringify(unsafeConfig), "utf8");

      const result = runCli([
        "--json",
        "config",
        "validate",
        "--config",
        configPath,
      ]);

      expect(result.status).toBeGreaterThan(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: {
          code: "USER_INPUT",
          message: expect.stringContaining("去除首尾空格后不能重复"),
        },
      });
    });
  });

  it.each(["file", "temporary", "persistent"])(
    "拒绝 %s 入口中的无上界播放列表值，且不回显该值",
    (entrypoint) => {
      const opaqueValue = `PL${"a".repeat(512)}`;

      withInitializedConfig((configPath) => {
        const savedConfig = readFileSync(configPath, "utf8");
        let result;

        if (entrypoint === "file") {
          const unsafeConfig = JSON.parse(savedConfig);
          unsafeConfig.analysisProfiles.corePerformance.filters.playlist =
            opaqueValue;
          writeFileSync(configPath, JSON.stringify(unsafeConfig), "utf8");
          result = runCli([
            "--json",
            "config",
            "validate",
            "--config",
            configPath,
          ]);
        } else if (entrypoint === "temporary") {
          result = runCli([
            "--json",
            "config",
            "validate",
            "--config",
            configPath,
            "--profile",
            "corePerformance",
            "--profile-filter",
            `playlist=${opaqueValue}`,
          ]);
        } else {
          result = runCli([
            "--json",
            "config",
            "set-profile",
            "--config",
            configPath,
            "--profile",
            "corePerformance",
            "--profile-filter",
            `playlist=${opaqueValue}`,
          ]);
        }

        expect(result.status).toBeGreaterThan(0);
        expect(result.stdout).not.toContain(opaqueValue);
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: false,
          error: { code: "USER_INPUT" },
        });
        if (entrypoint === "persistent") {
          expect(readFileSync(configPath, "utf8")).toBe(savedConfig);
        }
      });
    },
  );

  it("拒绝未分配的国家码", () => {
    withInitializedConfig((configPath) => {
      const result = runCli([
        "--json",
        "config",
        "validate",
        "--config",
        configPath,
        "--profile",
        "corePerformance",
        "--profile-filter",
        "country=ZZ",
      ]);

      expect(result.status).toBeGreaterThan(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { code: "USER_INPUT" },
      });
    });
  });

  it("拒绝把受保护凭据键用作分析档案名称", () => {
    const token = "do-not-echo-this-profile-token";

    withInitializedConfig((configPath) => {
      const unsafeConfig = JSON.parse(readFileSync(configPath, "utf8"));
      unsafeConfig.analysisProfiles.refreshToken = {
        ...unsafeConfig.analysisProfiles.corePerformance,
      };
      unsafeConfig.analysisProfiles.refreshToken.filters.country = token;
      writeFileSync(configPath, JSON.stringify(unsafeConfig), "utf8");

      const result = runCli([
        "--json",
        "config",
        "validate",
        "--config",
        configPath,
      ]);

      expect(result.status).toBeGreaterThan(0);
      expect(result.stdout).not.toContain(token);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: {
          code: "USER_INPUT",
          message: expect.stringContaining("受保护凭据"),
        },
      });
    });
  });

  it("拒绝将 OAuth 客户端密钥形状作为分析档案名称，且不修改配置", () => {
    const credential = "GOCSPX-AbCdEfGhIjKlMnOpQrStUvWxYz012345";

    withInitializedConfig((configPath) => {
      const savedConfig = readFileSync(configPath, "utf8");
      const result = runCli([
        "--json",
        "config",
        "set-profile",
        "--config",
        configPath,
        "--profile",
        credential,
        "--profile-metrics",
        "views",
        "--profile-dimensions",
        "day",
        "--profile-date-range",
        "last-7-days",
      ]);

      expect(result.status).toBeGreaterThan(0);
      expect(result.stdout).not.toContain(credential);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { code: "USER_INPUT" },
      });
      expect(readFileSync(configPath, "utf8")).toBe(savedConfig);
    });
  });

  it("拒绝配置文件中 OAuth 客户端密钥形状的分析档案名称", () => {
    const credential = "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7654";

    withInitializedConfig((configPath) => {
      const unsafeConfig = JSON.parse(readFileSync(configPath, "utf8"));
      unsafeConfig.analysisProfiles[credential] = {
        ...unsafeConfig.analysisProfiles.corePerformance,
      };
      writeFileSync(configPath, JSON.stringify(unsafeConfig), "utf8");

      const result = runCli([
        "--json",
        "config",
        "validate",
        "--config",
        configPath,
      ]);

      expect(result.status).toBeGreaterThan(0);
      expect(result.stdout).not.toContain(credential);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { code: "USER_INPUT" },
      });
    });
  });

  it("拒绝重复频道 ID，并说明如何修正", () => {
    withInitializedConfig((configPath) => {
      const invalidConfig = JSON.parse(readFileSync(configPath, "utf8"));
      invalidConfig.channels = [
        { channelId: testChannelId, enabled: true },
        { channelId: testChannelId, enabled: false },
      ];
      writeFileSync(configPath, JSON.stringify(invalidConfig), "utf8");

      const result = runCli([
        "--json",
        "config",
        "validate",
        "--config",
        configPath,
      ]);

      expect(result.status).toBeGreaterThan(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: {
          code: "USER_INPUT",
          message: expect.stringContaining("频道 ID 不能重复"),
        },
      });
    });
  });

  it.each(["accessToken", "cookie", "bearer", "session", "accessKey"])(
    "拒绝通过分析档案临时覆盖传入的凭据键 %s，且不回显其值",
    (credentialKey) => {
      const token = "do-not-echo-this-cli-token";

      withInitializedConfig((configPath) => {
        const result = runCli([
          "--json",
          "config",
          "validate",
          "--config",
          configPath,
          "--profile",
          "corePerformance",
          "--profile-filter",
          `${credentialKey}=${token}`,
        ]);

        expect(result.status).toBeGreaterThan(0);
        expect(result.stdout).not.toContain(token);
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: false,
          error: {
            code: "USER_INPUT",
            message: expect.stringContaining("受保护凭据"),
          },
        });
      });
    },
  );

  it("临时应用频道配置覆盖而不修改保存的配置", () => {
    withInitializedConfig((configPath) => {
      const result = runCli([
        "--json",
        "config",
        "validate",
        "--config",
        configPath,
        "--channel",
        testChannelId,
        "--channel-enabled",
        "false",
        "--channel-sync-frequency-hours",
        "12",
      ]);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        data: {
          valid: true,
          config: {
            channels: [
              {
                channelId: testChannelId,
                enabled: false,
                sync: { frequencyHours: 12 },
              },
            ],
          },
        },
      });
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
        channels: [],
      });
    });
  });

  it("显式持久化频道配置覆盖", () => {
    withInitializedConfig((configPath) => {
      const result = runCli([
        "--json",
        "config",
        "set-channel",
        "--config",
        configPath,
        "--channel",
        testChannelId,
        "--channel-enabled",
        "false",
        "--channel-sync-frequency-hours",
        "12",
      ]);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        data: {
          updated: true,
          config: {
            channels: [
              {
                channelId: testChannelId,
                enabled: false,
                sync: { frequencyHours: 12 },
              },
            ],
          },
        },
      });
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
        channels: [
          {
            channelId: testChannelId,
            enabled: false,
            sync: { frequencyHours: 12 },
          },
        ],
      });
    });
  });

  it("临时应用分析档案覆盖而不修改保存的配置", () => {
    withInitializedConfig((configPath) => {
      const result = runCli([
        "--json",
        "config",
        "validate",
        "--config",
        configPath,
        "--profile",
        "weekly",
        "--profile-metrics",
        "views,likes",
        "--profile-dimensions",
        "day",
        "--profile-date-range",
        "last-7-days",
        "--profile-filter",
        "country=US",
      ]);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        data: {
          valid: true,
          config: {
            analysisProfiles: {
              weekly: {
                metrics: ["views", "likes"],
                dimensions: ["day"],
                dateRange: "last-7-days",
                filters: { country: "US" },
              },
            },
          },
        },
      });
      expect(JSON.parse(readFileSync(configPath, "utf8"))).not.toHaveProperty(
        "analysisProfiles.weekly",
      );
    });
  });

  it("显式持久化分析档案覆盖", () => {
    withInitializedConfig((configPath) => {
      const result = runCli([
        "--json",
        "config",
        "set-profile",
        "--config",
        configPath,
        "--profile",
        "weekly",
        "--profile-metrics",
        "views,likes",
        "--profile-dimensions",
        "day",
        "--profile-date-range",
        "last-7-days",
        "--profile-filter",
        "country=US",
      ]);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        data: {
          updated: true,
          config: {
            analysisProfiles: {
              weekly: {
                metrics: ["views", "likes"],
                dimensions: ["day"],
                dateRange: "last-7-days",
                filters: { country: "US" },
              },
            },
          },
        },
      });
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toHaveProperty(
        "analysisProfiles.weekly",
      );
    });
  });

  it("把原型属性名称视为新分析档案，而不是已有档案", () => {
    withInitializedConfig((configPath) => {
      const result = runCli([
        "--json",
        "config",
        "validate",
        "--config",
        configPath,
        "--profile",
        "toString",
        "--profile-metrics",
        "views",
      ]);

      expect(result.status).toBeGreaterThan(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: {
          code: "USER_INPUT",
          message: expect.stringContaining("新建分析配置档案时"),
        },
      });
    });
  });

  it("逐项解释配置规则，并给出可修正的校验反馈", () => {
    const explanation = runCli(["--json", "config", "explain"]);
    const explanationData = JSON.parse(explanation.stdout).data;

    expect(explanation.status).toBe(0);
    expect(JSON.parse(explanation.stdout)).toMatchObject({
      ok: true,
      data: {
        global: {
          options: expect.arrayContaining([
            expect.objectContaining({
              name: "global.sync.frequencyHours",
              rule: expect.stringContaining("1 到 168"),
            }),
          ]),
        },
        channel: {
          options: expect.arrayContaining([
            expect.objectContaining({ name: "channels[].channelId" }),
            expect.objectContaining({
              name: "channels[].sync.frequencyHours",
            }),
            expect.objectContaining({
              name: "channels[].sync.maxConcurrency",
            }),
            expect.objectContaining({ name: "channels[].sync.quotaBudget" }),
            expect.objectContaining({
              name: "channels[].sync.initialBackfillDays",
            }),
          ]),
        },
        analysisProfile: {
          options: expect.arrayContaining([
            expect.objectContaining({
              name: "analysisProfiles.<name>.filters",
            }),
          ]),
        },
      },
    });

    for (const option of explanationData.global.options) {
      expect(option.temporaryCommand).toContain("--config <path>");
      expect(option.persistentCommand).toContain("--config <path>");
    }
    for (const option of explanationData.channel.options) {
      expect(option.temporaryCommand).toContain("--config <path>");
      expect(option.temporaryCommand).toContain("--channel <channel-id>");
      expect(option.persistentCommand).toContain("--config <path>");
      expect(option.persistentCommand).toContain("--channel <channel-id>");
    }
    for (const option of explanationData.analysisProfile.options) {
      expect(option.temporaryCommand).toContain("--config <path>");
      expect(option.temporaryCommand).toContain("--profile <name>");
      expect(option.persistentCommand).toContain("--config <path>");
      expect(option.persistentCommand).toContain("--profile <name>");
    }

    for (const layer of [
      explanationData.global,
      explanationData.channel,
      explanationData.analysisProfile,
    ]) {
      for (const option of layer.options) {
        expect(option.temporaryCommand).toMatch(/^ytops config /);
        expect(option.persistentCommand).toMatch(/^ytops config /);
        expect(option.temporaryCommand).not.toContain("（可重复）");
        expect(option.persistentCommand).not.toContain("（可重复）");
      }
    }

    const profileNameOption = explanationData.analysisProfile.options.find(
      (option: { name: string }) => option.name === "analysisProfiles.<name>",
    );
    expect(profileNameOption.temporaryCommand).toContain(
      "--profile-metrics <items>",
    );
    expect(profileNameOption.temporaryCommand).toContain(
      "--profile-dimensions <items>",
    );
    expect(profileNameOption.temporaryCommand).toContain(
      "--profile-date-range <range>",
    );

    const profileFiltersOption = explanationData.analysisProfile.options.find(
      (option: { name: string }) =>
        option.name === "analysisProfiles.<name>.filters",
    );
    expect(profileFiltersOption.temporaryCommand).toContain(
      "--profile-filter country=US",
    );

    for (const [name, optionName] of [
      ["channels[].sync.frequencyHours", "--channel-sync-frequency-hours"],
      ["channels[].sync.maxConcurrency", "--channel-max-concurrency"],
      ["channels[].sync.quotaBudget", "--channel-quota-budget"],
      [
        "channels[].sync.initialBackfillDays",
        "--channel-initial-backfill-days",
      ],
    ]) {
      const option = explanationData.channel.options.find(
        (candidate: { name: string }) => candidate.name === name,
      );
      expect(option.temporaryCommand).toContain(optionName);
      expect(option.persistentCommand).toContain(optionName);
    }

    withInitializedConfig((configPath) => {
      const invalidConfig = JSON.parse(readFileSync(configPath, "utf8"));
      invalidConfig.global.sync.frequencyHours = 0;
      writeFileSync(configPath, JSON.stringify(invalidConfig), "utf8");

      const result = runCli([
        "--json",
        "config",
        "validate",
        "--config",
        configPath,
      ]);
      const payload = JSON.parse(result.stdout);

      expect(result.status).toBeGreaterThan(0);
      expect(payload.error.message).toContain("global.sync.frequencyHours");
      expect(payload.error.message).toContain("1 到 168");
      expect(payload.error.message).toContain("修正");
    });
  });
});
