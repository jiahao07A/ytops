import { describe, expect, it, vi } from "vitest";
import { runDueInventoryTasks } from "../src/lib/scheduler.js";

const config = {
  global: {
    sync: {
      frequencyHours: 24,
      maxConcurrency: 2,
      quotaBudget: 10,
      initialBackfillDays: 365,
    },
  },
  channels: [
    { channelId: "UC1111111111111111111111", enabled: true },
    { channelId: "UC2222222222222222222222", enabled: true },
    { channelId: "UC3333333333333333333333", enabled: false },
  ],
} as never;

describe("runDueInventoryTasks", () => {
  it("只运行首次或已到期任务，并汇总单任务失败", async () => {
    const now = new Date("2026-01-02T00:00:00.000Z");
    const sync = vi.fn(async (_path: string, input: { channelId: string }) => {
      if (input.channelId === "UC2222222222222222222222")
        throw new Error("boom");
      return {
        channelId: input.channelId,
        task: { status: "completed" },
      } as never;
    });
    const result = await runDueInventoryTasks("config.json", {
      now: () => now,
      validateConfig: async () => ({
        valid: true,
        configPath: "config.json",
        config,
      }),
      getStatus: async (_p, channelId) =>
        channelId === "UC2222222222222222222222"
          ? ({
              channelId,
              task: { status: "completed", lastSuccessAt: now.toISOString() },
            } as never)
          : ({ channelId, task: { status: "queued" } } as never),
      syncInventory: sync,
    });
    expect(sync).toHaveBeenCalledTimes(1);
    expect(result.summary).toEqual({
      total: 2,
      due: 1,
      succeeded: 1,
      failed: 0,
      skipped: 1,
    });
    expect(result.tasks).toHaveLength(2);
    expect(
      result.tasks.find((t) => t.channelId === "UC1111111111111111111111")
        ?.status,
    ).toBe("completed");
  });

  it("按 maxConcurrency 限制并发，并隔离失败", async () => {
    let active = 0;
    let maxActive = 0;
    const sync = vi.fn(async (_p: string, input: { channelId: string }) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
      if (input.channelId.endsWith("2")) throw new Error("bad");
      return {
        channelId: input.channelId,
        task: { status: "completed" },
      } as never;
    });
    const many = {
      ...config,
      global: {
        ...config.global,
        sync: { ...config.global.sync, maxConcurrency: 1 },
      },
      channels: config.channels.slice(0, 2),
    } as never;
    const result = await runDueInventoryTasks("x", {
      now: () => new Date(),
      validateConfig: async () => ({
        valid: true,
        configPath: "x",
        config: many,
      }),
      getStatus: async (_p, channelId) =>
        ({ channelId, task: { status: "queued" } }) as never,
      syncInventory: sync,
    });
    expect(maxActive).toBe(1);
    expect(result.summary.failed).toBe(1);
  });

  it("传播同步任务的全部稳定状态，并按终止状态汇总", async () => {
    const statuses = [
      "queued",
      "running",
      "waiting",
      "retrying",
      "partial",
      "failed",
      "completed",
    ] as const;
    const statusConfig = {
      ...config,
      global: {
        ...config.global,
        sync: { ...config.global.sync, maxConcurrency: statuses.length },
      },
      channels: statuses.map((_, index) => ({
        channelId: `UC${String(index + 1).padStart(22, "0")}`,
        enabled: true,
      })),
    } as never;
    const sync = vi.fn(async (_path: string, input: { channelId: string }) => {
      const index = statusConfig.channels.findIndex(
        (channel: { channelId: string }) =>
          channel.channelId === input.channelId,
      );
      return {
        channelId: input.channelId,
        task: { status: statuses[index] },
      } as never;
    });
    const result = await runDueInventoryTasks("config.json", {
      validateConfig: async () => ({
        valid: true,
        configPath: "config.json",
        config: statusConfig,
      }),
      getStatus: async (_path, channelId) =>
        ({ channelId, task: { status: "queued" } }) as never,
      syncInventory: sync,
    });

    expect(result.tasks.map((task) => task.status)).toEqual(statuses);
    expect(result.summary).toEqual({
      total: statuses.length,
      due: statuses.length,
      succeeded: 1,
      failed: 1,
      skipped: 0,
    });
  });
});
