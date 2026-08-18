import { randomUUID } from "node:crypto";
import { existsSync, linkSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import lockfile from "proper-lockfile";
import { describe, expect, it } from "vitest";
import {
  initializeChannelOperationsConfig,
  updateAnalysisProfileOperationsConfig,
  updateGlobalChannelOperationsConfig,
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
