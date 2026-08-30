import { mkdir, mkdtemp, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { initializeChannelOperationsConfig } from "../src/lib/config.js";
import { getCoverageMatrix } from "../src/lib/coverage.js";

const channelId = "UC1111111111111111111111";

interface TestConnection {
  connectionId: string;
  channelId: string;
}

async function writeConnections(
  root: string,
  connections: TestConnection[],
): Promise<string> {
  const oauthDirectory = join(root, ".ytops-data", "oauth");
  const statePath = join(oauthDirectory, "connections.json");
  const timestamp = "2026-08-27T00:00:00.000Z";
  await mkdir(oauthDirectory, { recursive: true });
  await writeFile(
    statePath,
    `${JSON.stringify({
      version: 1,
      availableChannels: [],
      connections: connections.map((connection) => ({
        ...connection,
        title: "测试频道",
        status: "connected",
        credentialRef: `coverage-test:${connection.connectionId}`,
        scopes: ["https://www.googleapis.com/auth/youtube.readonly"],
        connectedAt: timestamp,
        updatedAt: timestamp,
      })),
    })}\n`,
    "utf8",
  );
  return statePath;
}

async function writeRetentionFixture(
  root: string,
  state: Record<string, unknown>,
): Promise<void> {
  const retentionDirectory = join(
    root,
    ".ytops-data",
    "retention",
    channelId,
    "evidence",
  );
  await mkdir(retentionDirectory, { recursive: true });
  await writeFile(
    join(root, ".ytops-data", "retention", channelId, "sync-state.json"),
    `${JSON.stringify(state)}\n`,
    "utf8",
  );
  await writeFile(
    join(root, ".ytops-data", "retention", channelId, "data.json"),
    `${JSON.stringify({
      version: 1,
      channelId,
      source: "youtube-analytics-api",
      startDate: "2005-07-14",
      endDate: "2026-08-19",
      curves: [
        {
          videoId: "video-001",
          points: [{ elapsedVideoTimeRatio: 0.01, audienceWatchRatio: 1.18 }],
          fetchedAt: "2026-08-19T00:00:00.000Z",
          evidencePath: join(retentionDirectory, "evidence-video-001.json"),
          coverage: "complete",
          dataAsOf: "2026-08-19T00:00:00.000Z",
        },
      ],
      coverage: "complete",
      dataAsOf: "2026-08-19T00:00:00.000Z",
      updatedAt: "2026-08-19T01:00:00.000Z",
    })}\n`,
    "utf8",
  );
}

async function cleanupFixture(root: string, configPath: string): Promise<void> {
  await unlink(join(root, ".ytops-data", "oauth", "connections.json")).catch(
    () => undefined,
  );
  await rmdir(join(root, ".ytops-data", "oauth")).catch(() => undefined);
  await rm(join(root, ".ytops-data", "retention"), {
    recursive: true,
    force: true,
  }).catch(() => undefined);
  await rmdir(join(root, ".ytops-data")).catch(() => undefined);
  await unlink(configPath).catch(() => undefined);
  await rmdir(root).catch(() => undefined);
}

describe("覆盖矩阵与证据审计", () => {
  it("在没有同步数据时明确标记不可用/部分支持，并保留能力边界", async () => {
    const root = await mkdtemp(join(tmpdir(), "ytops-coverage-"));
    const configPath = join(root, "config.json");
    try {
      await initializeChannelOperationsConfig(configPath, false);
      const matrix = await getCoverageMatrix(configPath, channelId);
      expect(matrix.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            capability: "inventory.metadata",
            status: "unavailable",
            evidencePaths: [],
          }),
          expect.objectContaining({
            capability: "analytics.breakdown",
            status: "partial",
          }),
          expect.objectContaining({
            capability: "analytics.audience",
            status: "unavailable",
          }),
          expect.objectContaining({
            capability: "comments.readonly",
            status: "unavailable",
          }),
          expect.objectContaining({
            capability: "retention.curve",
            status: "unavailable",
            evidencePaths: [],
          }),
        ]),
      );
      expect(JSON.stringify(matrix)).not.toContain("access-token");
    } finally {
      await cleanupFixture(root, configPath);
    }
  });

  it("唯一频道接入时仅公开 connection-scoped Inventory 证据目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "ytops-coverage-"));
    const configPath = join(root, "config.json");
    const connectionId = "coverage-connection-id";
    try {
      await initializeChannelOperationsConfig(configPath, false);
      await writeConnections(root, [{ connectionId, channelId }]);

      const matrix = await getCoverageMatrix(configPath, channelId);
      const inventory = matrix.entries.find(
        (entry) => entry.capability === "inventory.metadata",
      );

      expect(inventory).toMatchObject({
        status: "partial",
        evidencePaths: [
          resolve(
            root,
            ".ytops-data",
            "inventory",
            channelId,
            "connections",
            encodeURIComponent(connectionId),
            "tasks",
            "youtube-data-api",
            "channel+uploads+videos",
            "evidence",
          ),
        ],
      });
      expect(inventory?.evidencePaths[0]).not.toBe(
        resolve(root, ".ytops-data", "inventory", channelId, "evidence"),
      );
    } finally {
      await cleanupFixture(root, configPath);
    }
  });

  it("观众画像数据按同步状态呈现覆盖条目", async () => {
    const root = await mkdtemp(join(tmpdir(), "ytops-coverage-"));
    const configPath = join(root, "config.json");
    const analyticsRoot = join(root, ".ytops-data", "analytics", channelId);
    try {
      await initializeChannelOperationsConfig(configPath, false);
      await mkdir(join(analyticsRoot, "evidence"), { recursive: true });
      await writeFile(
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
          progress: { pages: 6, rows: 6 },
          checkpoint: {
            channelStartIndex: 1,
            videoStartIndex: 1,
            audience: { group: 4, startIndex: 1 },
          },
          coverage: "complete",
          audienceCoverage: "complete",
          updatedAt: "2026-08-19T01:00:00.000Z",
          lastSuccessAt: "2026-08-19T01:00:00.000Z",
          dataAsOf: "2026-08-19T00:00:00.000Z",
        })}\n`,
        "utf8",
      );
      await writeFile(
        join(analyticsRoot, "data.json"),
        `${JSON.stringify({
          version: 1,
          channelId,
          source: "youtube-analytics-api",
          channelRows: [],
          videoRows: [],
          audienceRows: [
            {
              dimensions: { day: "2026-08-19", country: "US" },
              metrics: { views: 4 },
            },
          ],
          evidence: [
            {
              path: "evidence-audience.json",
              phase: "audience",
              fetchedAt: "2026-08-19T01:00:00.000Z",
              request: {
                channelId,
                startDate: "2025-08-20",
                endDate: "2026-08-19",
                metrics: ["views"],
                dimensions: ["day", "country"],
              },
            },
          ],
          coverage: "complete",
          startDate: "2025-08-20",
          endDate: "2026-08-19",
          dataAsOf: "2026-08-19T00:00:00.000Z",
        })}\n`,
        "utf8",
      );

      const matrix = await getCoverageMatrix(configPath, channelId);
      expect(matrix.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            capability: "analytics.audience",
            status: "supported",
          }),
        ]),
      );
    } finally {
      await cleanupFixture(root, configPath);
      await rmdir(join(analyticsRoot, "evidence")).catch(() => undefined);
      await unlink(join(analyticsRoot, "sync-state.json")).catch(
        () => undefined,
      );
      await unlink(join(analyticsRoot, "data.json")).catch(() => undefined);
      await rmdir(analyticsRoot).catch(() => undefined);
      await rmdir(join(root, ".ytops-data", "analytics")).catch(
        () => undefined,
      );
    }
  });

  it("同一频道存在多个接入时保持覆盖查询成功且不猜测 Inventory 身份", async () => {
    const root = await mkdtemp(join(tmpdir(), "ytops-coverage-"));
    const configPath = join(root, "config.json");
    try {
      await initializeChannelOperationsConfig(configPath, false);
      await writeConnections(root, [
        { connectionId: "coverage-connection-a", channelId },
        { connectionId: "coverage-connection-b", channelId },
      ]);

      const matrix = await getCoverageMatrix(configPath, channelId);
      expect(matrix.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            capability: "inventory.metadata",
            status: "unavailable",
            evidencePaths: [],
          }),
        ]),
      );
    } finally {
      await cleanupFixture(root, configPath);
    }
  });

  it("留存曲线能力条目按同步状态映射，证据路径经凭据样文本过滤", async () => {
    const root = await mkdtemp(join(tmpdir(), "ytops-coverage-"));
    const configPath = join(root, "config.json");
    try {
      await initializeChannelOperationsConfig(configPath, false);
      await writeRetentionFixture(root, {
        version: 1,
        channelId,
        status: "completed",
        startDate: "2005-07-14",
        endDate: "2026-08-19",
        completedVideoIds: ["video-001"],
        pendingVideoIds: [],
        progress: { videos: 1, points: 1 },
        coverage: "complete",
        updatedAt: "2026-08-19T01:00:00.000Z",
        lastSuccessAt: "2026-08-19T01:00:00.000Z",
        dataAsOf: "2026-08-19T00:00:00.000Z",
      });

      const matrix = await getCoverageMatrix(configPath, channelId);
      const retention = matrix.entries.find(
        (entry) => entry.capability === "retention.curve",
      );
      expect(retention).toMatchObject({
        status: "supported",
        source: "youtube-analytics-api",
        dataAsOf: "2026-08-19T00:00:00.000Z",
        evidencePaths: [
          join(
            root,
            ".ytops-data",
            "retention",
            channelId,
            "evidence",
            "evidence-video-001.json",
          ),
        ],
      });
      expect(JSON.stringify(matrix)).not.toContain("access-token");

      await writeRetentionFixture(root, {
        version: 1,
        channelId,
        status: "failed",
        startDate: "2005-07-14",
        endDate: "2026-08-19",
        completedVideoIds: [],
        pendingVideoIds: ["video-001"],
        progress: { videos: 0, points: 0 },
        coverage: "permission-denied",
        updatedAt: "2026-08-19T01:00:00.000Z",
        error: {
          kind: "permission",
          message: "当前授权不包含 Analytics 读取权限。",
          retryable: false,
        },
      });
      const limited = await getCoverageMatrix(configPath, channelId);
      expect(
        limited.entries.find((entry) => entry.capability === "retention.curve"),
      ).toMatchObject({
        status: "qualification-limited",
        reason: "当前授权不包含 Analytics 读取权限。",
      });
    } finally {
      await cleanupFixture(root, configPath);
    }
  });
});
