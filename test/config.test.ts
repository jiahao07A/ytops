import { randomUUID } from "node:crypto";
import { existsSync, linkSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import lockfile from "proper-lockfile";
import { describe, expect, it } from "vitest";
import {
  initializeChannelOperationsConfig,
  resolveRevenueOptIn,
  updateAnalysisProfileOperationsConfig,
  updateChannelOperationsConfig,
  updateGlobalChannelOperationsConfig,
  validateChannelOperationsConfig,
} from "../src/lib/config.js";

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

describe("配置持久化", () => {
  it("在覆盖初始化前等待已存在的跨进程锁", async () => {
    const configPath = resolve(tmpdir(), `ytops-config-${randomUUID()}.json`);
    let release: (() => Promise<void>) | undefined;

    try {
      await initializeChannelOperationsConfig(configPath, false);
      const releaseLock = await lockfile.lock(configPath);
      release = releaseLock;
      let initializationCompleted = false;
      const initialization = initializeChannelOperationsConfig(
        configPath,
        true,
      ).then(() => {
        initializationCompleted = true;
      });

      await wait(50);
      expect(initializationCompleted).toBe(false);

      await releaseLock();
      release = undefined;
      await initialization;

      expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
        global: { sync: { frequencyHours: 24 } },
      });
    } finally {
      if (release !== undefined) {
        await release();
      }
      if (existsSync(configPath)) {
        unlinkSync(configPath);
      }
    }
  });

  it("等待已存在的跨进程锁后再执行读改写", async () => {
    const configPath = resolve(tmpdir(), `ytops-config-${randomUUID()}.json`);
    let release: (() => Promise<void>) | undefined;

    try {
      await initializeChannelOperationsConfig(configPath, false);
      const releaseLock = await lockfile.lock(configPath);
      release = releaseLock;
      let updateCompleted = false;
      const update = updateGlobalChannelOperationsConfig(configPath, {
        sync: { frequencyHours: 12 },
      }).then(() => {
        updateCompleted = true;
      });

      await wait(50);
      expect(updateCompleted).toBe(false);

      await releaseLock();
      release = undefined;
      await update;

      expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
        global: { sync: { frequencyHours: 12 } },
      });
    } finally {
      if (release !== undefined) {
        await release();
      }
      if (existsSync(configPath)) {
        unlinkSync(configPath);
      }
    }
  });

  it("串行合并并发的不同全局配置覆盖", async () => {
    const configPath = resolve(tmpdir(), `ytops-config-${randomUUID()}.json`);
    let release: (() => Promise<void>) | undefined;

    try {
      await initializeChannelOperationsConfig(configPath, false);
      const releaseLock = await lockfile.lock(configPath);
      release = releaseLock;

      const frequencyUpdate = updateGlobalChannelOperationsConfig(configPath, {
        sync: { frequencyHours: 12 },
      });
      const quotaUpdate = updateGlobalChannelOperationsConfig(configPath, {
        sync: { quotaBudget: 20_000 },
      });

      await wait(50);
      await releaseLock();
      release = undefined;
      await Promise.all([frequencyUpdate, quotaUpdate]);

      expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
        global: {
          sync: {
            frequencyHours: 12,
            quotaBudget: 20_000,
          },
        },
      });
    } finally {
      if (release !== undefined) {
        await release();
      }
      if (existsSync(configPath)) {
        unlinkSync(configPath);
      }
    }
  });

  it("拒绝通过库 API 写入嵌入式 OAuth 凭据，并保留原配置", async () => {
    const configPath = resolve(tmpdir(), `ytops-config-${randomUUID()}.json`);
    const credential = "do-not-echo-this-library-refresh-token";

    try {
      await initializeChannelOperationsConfig(configPath, false);
      const savedConfig = readFileSync(configPath, "utf8");
      const error = await updateGlobalChannelOperationsConfig(configPath, {
        dataDirectory: `safe/1//${credential}`,
      }).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(credential);
      expect(readFileSync(configPath, "utf8")).toBe(savedConfig);
    } finally {
      if (existsSync(configPath)) {
        unlinkSync(configPath);
      }
    }
  });

  it.each([
    "safe/client.secret=opaque-oauth-secret",
    "safe/access.token=opaque-oauth-token",
  ])("拒绝凭据字段使用点号的目录 %s", async (dataDirectory) => {
    const configPath = resolve(tmpdir(), `ytops-config-${randomUUID()}.json`);

    try {
      await initializeChannelOperationsConfig(configPath, false);
      const savedConfig = readFileSync(configPath, "utf8");
      const error = await updateGlobalChannelOperationsConfig(configPath, {
        dataDirectory,
      }).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(Error);
      expect(readFileSync(configPath, "utf8")).toBe(savedConfig);
    } finally {
      if (existsSync(configPath)) {
        unlinkSync(configPath);
      }
    }
  });

  it("拒绝带控制字符的分析档案名，并保留原配置", async () => {
    const configPath = resolve(tmpdir(), `ytops-config-${randomUUID()}.json`);

    try {
      await initializeChannelOperationsConfig(configPath, false);
      const savedConfig = readFileSync(configPath, "utf8");
      const error = await updateAnalysisProfileOperationsConfig(configPath, {
        name: "audit\nprofile",
        metrics: ["views"],
        dimensions: ["day"],
        dateRange: "last-7-days",
      }).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain("audit\nprofile");
      expect(readFileSync(configPath, "utf8")).toBe(savedConfig);
    } finally {
      if (existsSync(configPath)) {
        unlinkSync(configPath);
      }
    }
  });

  it("拒绝通过硬链接别名更新配置，避免写入分叉", async () => {
    const configPath = resolve(tmpdir(), `ytops-config-${randomUUID()}.json`);
    const aliasPath = resolve(
      tmpdir(),
      `ytops-config-alias-${randomUUID()}.json`,
    );

    try {
      await initializeChannelOperationsConfig(configPath, false);
      linkSync(configPath, aliasPath);
      const savedConfig = readFileSync(configPath, "utf8");
      const error = await updateGlobalChannelOperationsConfig(aliasPath, {
        sync: { frequencyHours: 12 },
      }).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("硬链接");
      expect(readFileSync(configPath, "utf8")).toBe(savedConfig);
      expect(readFileSync(aliasPath, "utf8")).toBe(savedConfig);
    } finally {
      if (existsSync(aliasPath)) {
        unlinkSync(aliasPath);
      }
      if (existsSync(configPath)) {
        unlinkSync(configPath);
      }
    }
  });
});

describe("公开检索 cookie 配置", () => {
  it("持久化 cookie 文件路径并可整体清除", async () => {
    const configPath = resolve(tmpdir(), `ytops-config-${randomUUID()}.json`);

    try {
      await initializeChannelOperationsConfig(configPath, false);
      await updateGlobalChannelOperationsConfig(configPath, {
        cookies: { file: "secrets/youtube-cookies.txt" },
      });
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
        global: { cookies: { file: "secrets/youtube-cookies.txt" } },
      });

      await updateGlobalChannelOperationsConfig(configPath, {
        cookies: null,
      });
      const cleared = JSON.parse(readFileSync(configPath, "utf8"));
      expect(cleared.global.cookies).toBeUndefined();
    } finally {
      if (existsSync(configPath)) {
        unlinkSync(configPath);
      }
    }
  });

  it("持久化浏览器 cookie 来源", async () => {
    const configPath = resolve(tmpdir(), `ytops-config-${randomUUID()}.json`);

    try {
      await initializeChannelOperationsConfig(configPath, false);
      await updateGlobalChannelOperationsConfig(configPath, {
        cookies: { fromBrowser: "firefox:dev-edition" },
      });
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
        global: { cookies: { fromBrowser: "firefox:dev-edition" } },
      });
    } finally {
      if (existsSync(configPath)) {
        unlinkSync(configPath);
      }
    }
  });

  it("拒绝同时设置两种 cookie 来源，并保留原配置", async () => {
    const configPath = resolve(tmpdir(), `ytops-config-${randomUUID()}.json`);

    try {
      await initializeChannelOperationsConfig(configPath, false);
      const savedConfig = readFileSync(configPath, "utf8");
      const error = await updateGlobalChannelOperationsConfig(configPath, {
        cookies: { file: "a/cookies.txt", fromBrowser: "firefox" },
      }).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("只能配置其中一种来源");
      expect(readFileSync(configPath, "utf8")).toBe(savedConfig);
    } finally {
      if (existsSync(configPath)) {
        unlinkSync(configPath);
      }
    }
  });

  it("拒绝凭据形状或非结构化的 cookie 文件路径", async () => {
    const configPath = resolve(tmpdir(), `ytops-config-${randomUUID()}.json`);

    try {
      await initializeChannelOperationsConfig(configPath, false);
      const savedConfig = readFileSync(configPath, "utf8");

      for (const cookies of [
        { file: "GOCSPX-do-not-store-cookie-path" },
        { file: "https://example.com/cookies.txt" },
        { file: "cookies.txt\n more" },
      ]) {
        const error = await updateGlobalChannelOperationsConfig(configPath, {
          cookies,
        }).catch((reason: unknown) => reason);
        expect(error).toBeInstanceOf(Error);
      }

      expect(readFileSync(configPath, "utf8")).toBe(savedConfig);
    } finally {
      if (existsSync(configPath)) {
        unlinkSync(configPath);
      }
    }
  });

  it("拒绝不支持或凭据形状的浏览器来源", async () => {
    const configPath = resolve(tmpdir(), `ytops-config-${randomUUID()}.json`);

    try {
      await initializeChannelOperationsConfig(configPath, false);
      const savedConfig = readFileSync(configPath, "utf8");

      for (const cookies of [
        { fromBrowser: "safari18" },
        { fromBrowser: "access_token=abc firefox" },
      ]) {
        const error = await updateGlobalChannelOperationsConfig(configPath, {
          cookies,
        }).catch((reason: unknown) => reason);
        expect(error).toBeInstanceOf(Error);
      }

      expect(readFileSync(configPath, "utf8")).toBe(savedConfig);
    } finally {
      if (existsSync(configPath)) {
        unlinkSync(configPath);
      }
    }
  });

  it("拒绝 cookie 设置中的未声明字段", async () => {
    const configPath = resolve(tmpdir(), `ytops-config-${randomUUID()}.json`);

    try {
      await initializeChannelOperationsConfig(configPath, false);
      const savedConfig = readFileSync(configPath, "utf8");
      const error = await updateGlobalChannelOperationsConfig(configPath, {
        cookies: {
          file: "a/cookies.txt",
          value: "do-not-store-cookie-content",
        } as unknown as { file: string },
      }).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(Error);
      expect(readFileSync(configPath, "utf8")).toBe(savedConfig);
    } finally {
      if (existsSync(configPath)) {
        unlinkSync(configPath);
      }
    }
  });

  it("货币分析权限 opt-in 默认关闭，按全局与频道覆盖解析", async () => {
    const configPath = resolve(tmpdir(), `ytops-config-${randomUUID()}.json`);
    const channelId = "UC1111111111111111111111";
    try {
      await initializeChannelOperationsConfig(configPath, false);
      const initial = await validateChannelOperationsConfig(configPath);
      expect(resolveRevenueOptIn(initial.config, channelId)).toBe(false);

      await updateGlobalChannelOperationsConfig(configPath, {
        analytics: { revenueOptIn: true },
      });
      const globalEnabled = await validateChannelOperationsConfig(configPath);
      expect(resolveRevenueOptIn(globalEnabled.config, channelId)).toBe(true);

      await updateChannelOperationsConfig(configPath, {
        channelId,
        analytics: { revenueOptIn: false },
      });
      const channelDisabled = await validateChannelOperationsConfig(configPath);
      expect(resolveRevenueOptIn(channelDisabled.config, channelId)).toBe(
        false,
      );
      expect(
        resolveRevenueOptIn(channelDisabled.config, "UC2222222222222222222222"),
      ).toBe(true);
    } finally {
      if (existsSync(configPath)) {
        unlinkSync(configPath);
      }
    }
  });
});
