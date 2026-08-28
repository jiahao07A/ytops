import { describe, expect, it } from "vitest";
import {
  createSyncTaskIdentity,
  isTerminalSyncTaskFailure,
  type SyncTaskProjection,
} from "../src/lib/sync-task.js";

describe("统一同步任务合同", () => {
  it("按频道接入、数据源和规范化范围生成稳定身份", () => {
    const identity = createSyncTaskIdentity({
      channelConnectionId: "UC1111111111111111111111",
      source: "youtube-data-api",
      scope: ["videos", "channel", "channel"],
    });

    expect(identity).toEqual({
      id: "youtube-data-api:UC1111111111111111111111:channel+videos",
      channelConnectionId: "UC1111111111111111111111",
      source: "youtube-data-api",
      scope: ["channel", "videos"],
    });
  });

  it("只有 failed 状态是终止失败", () => {
    const projection = (status: SyncTaskProjection["status"]) => ({
      id: `task:${status}`,
      identity: {
        id: `task:${status}`,
        channelConnectionId: "UC1111111111111111111111",
        source: "youtube-data-api",
        scope: ["channel"],
      },
      status,
      updatedAt: "2026-08-27T00:00:00.000Z",
      retryable: status === "retrying",
    });

    expect(isTerminalSyncTaskFailure(projection("failed"))).toBe(true);
    for (const status of [
      "queued",
      "running",
      "waiting",
      "retrying",
      "partial",
      "completed",
    ] as const) {
      expect(isTerminalSyncTaskFailure(projection(status))).toBe(false);
    }
  });
});
