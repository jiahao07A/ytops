import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { mkdtemp, readFile, readdir, rmdir, writeFile } from "node:fs/promises";
import lockfile from "proper-lockfile";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeChannelOperationsConfig } from "../src/lib/config.js";
import {
  disableTaskScheduler,
  getTaskSchedulerStatus,
  installTaskScheduler,
} from "../src/lib/task-scheduler.js";

const taskName = "ytops-inventory-scheduler";

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function withFixture(
  run: (configPath: string, statePath: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ytops-task-scheduler-"));
  const configPath = join(root, "config.json");
  const statePath = `${configPath}.scheduler.json`;
  await initializeChannelOperationsConfig(configPath, false);
  try {
    await run(configPath, statePath);
  } finally {
    for (const path of [statePath, `${statePath}.lock`, configPath]) {
      if (existsSync(path)) {
        unlinkSync(path);
      }
    }
    await rmdir(root).catch(() => undefined);
  }
}

describe("Task Scheduler 状态适配器", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("缺失状态文件表示尚未安装", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    await withFixture(async (configPath) => {
      await expect(getTaskSchedulerStatus(configPath)).resolves.toMatchObject({
        supported: true,
        installed: false,
        state: undefined,
      });
    });
  });

  it("拒绝畸形或未知字段的状态文件，并保留结构化错误类别", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    await withFixture(async (configPath, statePath) => {
      await writeFile(statePath, JSON.stringify({ enabled: true }), "utf8");
      const error = await getTaskSchedulerStatus(configPath).catch(
        (reason: unknown) => reason,
      );

      expect(error).toMatchObject({
        kind: "invalid-state",
        retryable: false,
      });
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("格式无效");
    });
  });

  it("安装使用可验证的完整状态，并以原子替换写入", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    await withFixture(async (configPath, statePath) => {
      const result = await installTaskScheduler(configPath, true);
      expect(result).toMatchObject({
        installed: true,
        changed: true,
        state: {
          taskName,
          enabled: true,
          frequencyHours: 24,
        },
      });
      const saved = JSON.parse(await readFile(statePath, "utf8")) as Record<
        string,
        unknown
      >;
      expect(saved).toMatchObject({ taskName, enabled: true });
      expect(await readFile(statePath, "utf8")).toContain("\n");
      const entries = await readdir(dirname(statePath));
      expect(entries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    });
  });

  it("安装在锁占用时等待后再读改写，避免并发丢更新", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    await withFixture(async (configPath, statePath) => {
      const release = await lockfile.lock(statePath, {
        realpath: false,
      });
      let completed = false;
      const operation = installTaskScheduler(configPath, true).then(() => {
        completed = true;
      });
      await wait(50);
      expect(completed).toBe(false);
      await release();
      await operation;
      expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
        enabled: true,
      });
    });
  });

  it("停用已停用任务保持幂等，并通过同一锁保护读改写", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    await withFixture(async (configPath) => {
      await installTaskScheduler(configPath, true);
      const first = await disableTaskScheduler(configPath, true);
      const second = await disableTaskScheduler(configPath, true);
      expect(first).toMatchObject({ installed: false, changed: true });
      expect(second).toMatchObject({
        installed: false,
        changed: false,
        requiresConfirmation: false,
        state: { enabled: false },
      });
    });
  });
});
