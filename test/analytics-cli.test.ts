import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const channelId = "UC1111111111111111111111";

function runCli(args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync(
    process.execPath,
    [resolve(process.cwd(), "dist", "cli.js"), ...args],
    { encoding: "utf8", env },
  );
}

describe("CLI 频道核心 Analytics", () => {
  it("以稳定 JSON 输出已保存事实、覆盖状态和数据截至时间", () => {
    const root = join(tmpdir(), `ytops-analytics-cli-${randomUUID()}`);
    const configPath = join(root, "config.json");
    const analyticsRoot = join(root, ".ytops-data", "analytics", channelId);
    mkdirSync(analyticsRoot, { recursive: true });
    try {
      const initialized = runCli([
        "--json",
        "config",
        "init",
        "--output",
        configPath,
      ]);
      expect(initialized.status).toBe(0);
      writeFileSync(
        join(analyticsRoot, "sync-state.json"),
        `${JSON.stringify({
          version: 1,
          channelId,
          status: "completed",
          phase: "complete",
          requestedDays: 365,
          startDate: "2025-08-20",
          endDate: "2026-08-19",
          metrics: ["views"],
          progress: { pages: 2, rows: 2 },
          checkpoint: { channelStartIndex: 0, videoStartIndex: 0 },
          coverage: "partial",
          updatedAt: "2026-08-19T01:00:00.000Z",
          dataAsOf: "2026-08-19T00:00:00.000Z",
          lastSuccessAt: "2026-08-19T01:00:00.000Z",
        })}\n`,
        "utf8",
      );
      writeFileSync(
        join(analyticsRoot, "data.json"),
        `${JSON.stringify({
          version: 1,
          channelId,
          source: "youtube-analytics-api",
          channelRows: [
            {
              dimensions: { day: "2026-08-19" },
              metrics: {
                views: 10,
                engagedViews: 8,
                dislikes: 1,
                estimatedRevenue: 0.4,
              },
            },
          ],
          videoRows: [],
          evidence: [],
          coverage: "partial",
          startDate: "2025-08-20",
          endDate: "2026-08-19",
          dataAsOf: "2026-08-19T00:00:00.000Z",
          updatedAt: "2026-08-19T01:00:00.000Z",
        })}\n`,
        "utf8",
      );

      const result = runCli([
        "--json",
        "ops",
        "channel",
        "analytics-query",
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
          state: {
            status: "completed",
            coverage: "partial",
            dataAsOf: "2026-08-19T00:00:00.000Z",
          },
          data: {
            coverage: "partial",
            dataAsOf: "2026-08-19T00:00:00.000Z",
            channelRows: [
              {
                dimensions: { day: "2026-08-19" },
                metrics: {
                  views: 10,
                  engagedViews: 8,
                  dislikes: 1,
                  estimatedRevenue: 0.4,
                },
              },
            ],
          },
        },
      });
    } finally {
      const statePath = join(analyticsRoot, "sync-state.json");
      const dataPath = join(analyticsRoot, "data.json");
      if (existsSync(statePath)) unlinkSync(statePath);
      if (existsSync(dataPath)) unlinkSync(dataPath);
      if (existsSync(configPath)) unlinkSync(configPath);
      if (existsSync(analyticsRoot)) rmdirSync(analyticsRoot);
      const analyticsPath = join(root, ".ytops-data", "analytics");
      if (existsSync(analyticsPath)) rmdirSync(analyticsPath);
      const dataRoot = join(root, ".ytops-data");
      if (existsSync(dataRoot)) rmdirSync(dataRoot);
      if (existsSync(root)) rmdirSync(root);
    }
  });

  it("analytics-read --derived 在读取时派生 RPM 与赞踩比，不落盘", () => {
    const root = join(tmpdir(), `ytops-analytics-cli-${randomUUID()}`);
    const configPath = join(root, "config.json");
    const analyticsRoot = join(root, ".ytops-data", "analytics", channelId);
    mkdirSync(analyticsRoot, { recursive: true });
    try {
      const initialized = runCli([
        "--json",
        "config",
        "init",
        "--output",
        configPath,
      ]);
      expect(initialized.status).toBe(0);
      writeFileSync(
        join(analyticsRoot, "sync-state.json"),
        `${JSON.stringify({
          version: 1,
          channelId,
          status: "completed",
          phase: "complete",
          requestedDays: 365,
          startDate: "2025-08-20",
          endDate: "2026-08-19",
          metrics: ["views"],
          progress: { pages: 2, rows: 2 },
          checkpoint: { channelStartIndex: 1, videoStartIndex: 1 },
          coverage: "partial",
          updatedAt: "2026-08-19T01:00:00.000Z",
          dataAsOf: "2026-08-19T00:00:00.000Z",
          lastSuccessAt: "2026-08-19T01:00:00.000Z",
        })}\n`,
        "utf8",
      );
      writeFileSync(
        join(analyticsRoot, "data.json"),
        `${JSON.stringify({
          version: 1,
          channelId,
          source: "youtube-analytics-api",
          channelRows: [
            {
              dimensions: { day: "2026-08-19" },
              metrics: {
                views: 10,
                engagedViews: 8,
                dislikes: 2,
                likes: 30,
                estimatedRevenue: 0.4,
              },
            },
          ],
          videoRows: [],
          evidence: [],
          coverage: "partial",
          startDate: "2025-08-20",
          endDate: "2026-08-19",
          dataAsOf: "2026-08-19T00:00:00.000Z",
          updatedAt: "2026-08-19T01:00:00.000Z",
        })}\n`,
        "utf8",
      );

      const result = runCli([
        "--json",
        "ops",
        "channel",
        "analytics-read",
        "--config",
        configPath,
        "--channel",
        channelId,
        "--derived",
      ]);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toMatchObject({
        ok: true,
        data: {
          data: {
            derivedRows: [
              {
                dimensions: { day: "2026-08-19" },
                derived: {
                  rpmPerThousandEngagedViews: 50,
                  likeToDislikeRatio: 15,
                },
              },
            ],
          },
        },
      });
      const savedData = JSON.parse(
        readFileSync(join(analyticsRoot, "data.json"), "utf8"),
      );
      expect(savedData.derivedRows).toBeUndefined();
    } finally {
      const statePath = join(analyticsRoot, "sync-state.json");
      const dataPath = join(analyticsRoot, "data.json");
      if (existsSync(statePath)) unlinkSync(statePath);
      if (existsSync(dataPath)) unlinkSync(dataPath);
      if (existsSync(configPath)) unlinkSync(configPath);
      if (existsSync(analyticsRoot)) rmdirSync(analyticsRoot);
      const analyticsPath = join(root, ".ytops-data", "analytics");
      if (existsSync(analyticsPath)) rmdirSync(analyticsPath);
      const dataRoot = join(root, ".ytops-data");
      if (existsSync(dataRoot)) rmdirSync(dataRoot);
      if (existsSync(root)) rmdirSync(root);
    }
  });
});
