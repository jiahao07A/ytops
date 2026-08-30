import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const channelId = "UC1111111111111111111111";

function runCli(args: string[]) {
  return spawnSync(
    process.execPath,
    [resolve(process.cwd(), "dist", "cli.js"), ...args],
    { encoding: "utf8" },
  );
}

interface RetentionCliFixture {
  root: string;
  configPath: string;
  retentionRoot: string;
  writeRetentionState: (state: Record<string, unknown>) => void;
  writeRetentionData: (data: Record<string, unknown>) => void;
  cleanup: () => void;
}

function withRetentionCliFixture(
  run: (fixture: RetentionCliFixture) => void,
): void {
  const root = join(tmpdir(), `ytops-retention-cli-${randomUUID()}`);
  const configPath = join(root, "config.json");
  const retentionRoot = join(root, ".ytops-data", "retention", channelId);
  mkdirSync(retentionRoot, { recursive: true });
  try {
    const initialized = runCli([
      "--json",
      "config",
      "init",
      "--output",
      configPath,
    ]);
    expect(initialized.status).toBe(0);
    run({
      root,
      configPath,
      retentionRoot,
      writeRetentionState: (state) => {
        writeFileSync(
          join(retentionRoot, "sync-state.json"),
          `${JSON.stringify(state)}\n`,
          "utf8",
        );
      },
      writeRetentionData: (data) => {
        writeFileSync(
          join(retentionRoot, "data.json"),
          `${JSON.stringify(data)}\n`,
          "utf8",
        );
      },
      cleanup: () => undefined,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const completedState = {
  version: 1,
  channelId,
  status: "completed",
  startDate: "2005-07-14",
  endDate: "2026-08-19",
  completedVideoIds: ["video-001"],
  pendingVideoIds: [],
  progress: { videos: 1, points: 2 },
  coverage: "complete",
  updatedAt: "2026-08-19T01:00:00.000Z",
  lastSuccessAt: "2026-08-19T01:00:00.000Z",
  dataAsOf: "2026-08-19T00:00:00.000Z",
};

const completedData = {
  version: 1,
  channelId,
  source: "youtube-analytics-api",
  startDate: "2005-07-14",
  endDate: "2026-08-19",
  curves: [
    {
      videoId: "video-001",
      points: [
        { elapsedVideoTimeRatio: 0.01, audienceWatchRatio: 1.18 },
        { elapsedVideoTimeRatio: 0.02, audienceWatchRatio: 0.98 },
      ],
      fetchedAt: "2026-08-19T00:00:00.000Z",
      evidencePath: "evidence/retention-video-001.json",
      coverage: "complete",
      dataAsOf: "2026-08-19T00:00:00.000Z",
    },
  ],
  coverage: "complete",
  dataAsOf: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T01:00:00.000Z",
};

describe("CLI 留存曲线", () => {
  it("retention-status 以稳定 JSON 输出同步状态、检查点和数据截至时间", () => {
    withRetentionCliFixture(({ configPath, writeRetentionState, writeRetentionData }) => {
      writeRetentionState(completedState);
      writeRetentionData(completedData);

      const result = runCli([
        "--json",
        "ops",
        "channel",
        "retention-status",
        "--config",
        configPath,
        "--channel",
        channelId,
      ]);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        data: {
          channelId,
          state: {
            status: "completed",
            coverage: "complete",
            completedVideoIds: ["video-001"],
            pendingVideoIds: [],
            dataAsOf: "2026-08-19T00:00:00.000Z",
          },
          data: {
            coverage: "complete",
            dataAsOf: "2026-08-19T00:00:00.000Z",
            curves: [
              {
                videoId: "video-001",
                points: [
                  { elapsedVideoTimeRatio: 0.01, audienceWatchRatio: 1.18 },
                  { elapsedVideoTimeRatio: 0.02, audienceWatchRatio: 0.98 },
                ],
              },
            ],
          },
        },
      });
    });
  });

  it("retention-read 返回单个视频的全历史留存曲线并如实呈现超过 100% 的点", () => {
    withRetentionCliFixture(({ configPath, writeRetentionState, writeRetentionData }) => {
      writeRetentionState(completedState);
      writeRetentionData(completedData);

      const result = runCli([
        "--json",
        "ops",
        "channel",
        "retention-read",
        "--config",
        configPath,
        "--channel",
        channelId,
        "--video",
        "video-001",
      ]);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const payload = JSON.parse(result.stdout);
      expect(payload).toMatchObject({
        ok: true,
        data: {
          channelId,
          videoId: "video-001",
          mode: "cached",
          stale: true,
          dataAsOf: "2026-08-19T00:00:00.000Z",
          curve: {
            videoId: "video-001",
            points: [
              { elapsedVideoTimeRatio: 0.01, audienceWatchRatio: 1.18 },
              { elapsedVideoTimeRatio: 0.02, audienceWatchRatio: 0.98 },
            ],
          },
          refresh: { attempted: false, status: "not-requested" },
        },
      });
    });
  });

  it("retention-read 对缺失曲线的失败不伪装成事实", () => {
    withRetentionCliFixture(({ configPath, writeRetentionState, writeRetentionData }) => {
      writeRetentionState(completedState);
      writeRetentionData(completedData);

      const result = runCli([
        "--json",
        "ops",
        "channel",
        "retention-read",
        "--config",
        configPath,
        "--channel",
        channelId,
        "--video",
        "video-404",
      ]);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { code: "RETENTION_SERVICE" },
      });
    });
  });

  it("retention-sync 在尚无已完成的视频清单时返回失败", () => {
    withRetentionCliFixture(({ configPath }) => {
      const result = runCli([
        "--json",
        "ops",
        "channel",
        "retention-sync",
        "--config",
        configPath,
        "--channel",
        channelId,
      ]);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { code: "RETENTION_SERVICE" },
      });
    });
  });
});
