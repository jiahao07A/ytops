import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initializeChannelOperationsConfig } from "../src/lib/config.js";
import {
  GoogleRetentionProvider,
  RETENTION_FULL_HISTORY_START_DATE,
  type RetentionCurveRequest,
  type RetentionProvider,
  type RetentionProviderResult,
  syncRetention,
  readRetentionCurve,
} from "../src/lib/retention.js";
import { RetentionServiceError } from "../src/lib/errors.js";
import { MemoryCredentialStore } from "../src/lib/oauth.js";

const channelId = "UC1111111111111111111111";
const accessTokenLiteral = "retention-access-token-must-not-leak";

class FakeRetentionProvider implements RetentionProvider {
  readonly requests: Array<RetentionCurveRequest & { accessToken: string }> = [];

  constructor(
    private readonly results: Map<string, RetentionProviderResult | Error>,
  ) {}

  async queryCurve(
    input: RetentionCurveRequest & { accessToken: string },
  ): Promise<RetentionProviderResult> {
    this.requests.push(input);
    const result = this.results.get(input.videoId);
    if (result instanceof Error) {
      throw result;
    }
    if (result === undefined) {
      throw new Error(`unexpected query for ${input.videoId}`);
    }
    return result;
  }
}

function curveResult(
  points: Array<{ elapsedVideoTimeRatio: number; audienceWatchRatio: number }>,
  raw: unknown,
  dataAsOf?: string,
): RetentionProviderResult {
  return {
    points,
    raw,
    coverage: points.length > 0 ? "complete" : "unavailable",
    ...(dataAsOf === undefined ? {} : { dataAsOf }),
  };
}

async function withRetentionFixture(
  run: (fixture: {
    configPath: string;
    dataRoot: string;
    store: MemoryCredentialStore;
    writeInventory: (videoIds: string[]) => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ytops-retention-"));
  const configPath = join(root, "config.json");
  const dataRoot = join(root, ".ytops-data");
  const statePath = join(dataRoot, "oauth", "connections.json");
  const store = new MemoryCredentialStore();
  await initializeChannelOperationsConfig(configPath, false);
  await store.set("credential-ref", {
    accessToken: accessTokenLiteral,
    refreshToken: "refresh-token",
  });
  await mkdir(join(dataRoot, "oauth"), { recursive: true });
  await writeFile(
    statePath,
    `${JSON.stringify({
      version: 1,
      availableChannels: [{ id: channelId, title: "主频道" }],
      selectedChannelId: channelId,
      connections: [
        {
          connectionId: "connection-id",
          channelId,
          title: "主频道",
          status: "connected",
          credentialRef: "credential-ref",
          scopes: ["https://www.googleapis.com/auth/youtube.readonly"],
          connectedAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
    })}\n`,
    "utf8",
  );
  const writeInventory = async (videoIds: string[]): Promise<void> => {
    const taskRoot = join(
      dataRoot,
      "inventory",
      channelId,
      "connections",
      "connection-id",
      "tasks",
      "youtube-data-api",
      "channel+uploads+videos",
    );
    const fetchedAt = "2026-08-19T00:00:00.000Z";
    await mkdir(taskRoot, { recursive: true });
    await writeFile(
      join(taskRoot, "sync-state.json"),
      `${JSON.stringify({
        version: 2,
        channelId,
        channelConnectionId: "connection-id",
        status: "completed",
        scope: { channel: true, uploads: true, videos: true },
        phase: "complete",
        progress: { pages: 1, items: videoIds.length, videoItems: videoIds.length },
        checkpoint: { videoIndex: videoIds.length, videoIds },
        updatedAt: fetchedAt,
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(taskRoot, "data.json"),
      `${JSON.stringify({
        version: 1,
        channelId,
        source: "youtube-data-api",
        uploads: [],
        videos: videoIds.map((id) => ({
          id,
          title: `库存视频 ${id}`,
          fetchedAt,
        })),
      })}\n`,
      "utf8",
    );
  };

  try {
    await run({ configPath, dataRoot, store, writeInventory });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("留存曲线同步任务", () => {
  it("首次留存同步对库存全部视频各建立一条全历史留存曲线", async () => {
    await withRetentionFixture(async ({ configPath, store, writeInventory }) => {
      await writeInventory(["video-001", "video-002"]);
      const provider = new FakeRetentionProvider(
        new Map([
          [
            "video-001",
            curveResult(
              [
                { elapsedVideoTimeRatio: 0.01, audienceWatchRatio: 1 },
                { elapsedVideoTimeRatio: 0.02, audienceWatchRatio: 0.98 },
                { elapsedVideoTimeRatio: 0.5, audienceWatchRatio: 0.42 },
              ],
              { video: "video-001" },
              "2026-08-19T01:00:00.000Z",
            ),
          ],
          [
            "video-002",
            curveResult(
              [
                { elapsedVideoTimeRatio: 0.01, audienceWatchRatio: 1.18 },
                { elapsedVideoTimeRatio: 0.02, audienceWatchRatio: 1.02 },
              ],
              { video: "video-002" },
            ),
          ],
        ]),
      );

      const result = await syncRetention(
        configPath,
        { channelId },
        {
          provider,
          credentialStore: store,
          now: () => new Date("2026-08-19T12:00:00.000Z"),
        },
      );

      expect(result.state.status).toBe("completed");
      expect(result.state.startDate).toBe(RETENTION_FULL_HISTORY_START_DATE);
      expect(result.state.endDate).toBe("2026-08-19");
      expect(result.state.completedVideoIds).toEqual([
        "video-001",
        "video-002",
      ]);
      expect(result.state.pendingVideoIds).toEqual([]);
      expect(result.state.progress).toEqual({ videos: 2, points: 5 });
      expect(result.state.coverage).toBe("complete");
      expect(result.state.lastSuccessAt).toBe("2026-08-19T12:00:00.000Z");
      expect(result.state.dataAsOf).toBe("2026-08-19T12:00:00.000Z");
      expect(result.data.coverage).toBe("complete");
      expect(provider.requests).toHaveLength(2);
      expect(provider.requests[0]).toMatchObject({
        accessToken: accessTokenLiteral,
        channelId,
        videoId: "video-001",
        startDate: RETENTION_FULL_HISTORY_START_DATE,
        endDate: "2026-08-19",
      });
      expect(provider.requests[1].videoId).toBe("video-002");
      const videoTwo = result.data.curves.find(
        (curve) => curve.videoId === "video-002",
      );
      expect(videoTwo?.points[0]).toEqual({
        elapsedVideoTimeRatio: 0.01,
        audienceWatchRatio: 1.18,
      });
      expect(videoTwo?.points[1]).toEqual({
        elapsedVideoTimeRatio: 0.02,
        audienceWatchRatio: 1.02,
      });
    });
  });

  it("原始证据落盘且不含受保护凭据样文本", async () => {
    await withRetentionFixture(async ({ configPath, store, writeInventory }) => {
      await writeInventory(["video-001"]);
      const provider = new FakeRetentionProvider(
        new Map([
          [
            "video-001",
            curveResult(
              [{ elapsedVideoTimeRatio: 0.01, audienceWatchRatio: 0.9 }],
              { video: "video-001" },
            ),
          ],
        ]),
      );
      const result = await syncRetention(
        configPath,
        { channelId },
        {
          provider,
          credentialStore: store,
          now: () => new Date("2026-08-19T12:00:00.000Z"),
        },
      );
      const curve = result.data.curves.find(
        (candidate) => candidate.videoId === "video-001",
      );
      expect(curve?.evidencePath).toContain(
        join(".ytops-data", "retention", channelId, "evidence"),
      );
      const evidence = await readFile(curve?.evidencePath ?? "", "utf8");
      expect(evidence).toContain("video-001");
      expect(evidence).toContain("audienceWatchRatio");
      expect(evidence).not.toContain(accessTokenLiteral);
    });
  });

  it("中断后从检查点恢复，不重复拉取已完成视频", async () => {
    await withRetentionFixture(async ({ configPath, store, writeInventory }) => {
      await writeInventory(["video-001", "video-002"]);
      const firstProvider = new FakeRetentionProvider(
        new Map([
          [
            "video-001",
            curveResult(
              [
                { elapsedVideoTimeRatio: 0.01, audienceWatchRatio: 1 },
                { elapsedVideoTimeRatio: 0.02, audienceWatchRatio: 0.98 },
                { elapsedVideoTimeRatio: 0.03, audienceWatchRatio: 0.9 },
              ],
              { page: "video-001" },
            ),
          ],
        ]),
      );
      const first = await syncRetention(
        configPath,
        { channelId, maxWorkUnits: 1 },
        {
          provider: firstProvider,
          credentialStore: store,
          now: () => new Date("2026-08-19T12:00:00.000Z"),
        },
      );
      expect(first.state.status).toBe("partial");
      expect(first.state.completedVideoIds).toEqual(["video-001"]);
      expect(first.state.pendingVideoIds).toEqual(["video-002"]);
      expect(first.state.error).toMatchObject({ kind: "checkpoint" });

      const secondProvider = new FakeRetentionProvider(
        new Map([
          [
            "video-002",
            curveResult(
              [{ elapsedVideoTimeRatio: 0.01, audienceWatchRatio: 1.18 }],
              { page: "video-002" },
            ),
          ],
        ]),
      );
      const second = await syncRetention(
        configPath,
        { channelId },
        {
          provider: secondProvider,
          credentialStore: store,
          now: () => new Date("2026-08-19T13:00:00.000Z"),
        },
      );
      expect(second.state.status).toBe("completed");
      expect(second.state.completedVideoIds).toEqual([
        "video-001",
        "video-002",
      ]);
      expect(secondProvider.requests).toHaveLength(1);
      expect(secondProvider.requests[0].videoId).toBe("video-002");
      expect(second.data.curves).toHaveLength(2);
      expect(second.data.curves.map((curve) => curve.videoId)).toEqual([
        "video-001",
        "video-002",
      ]);
    });
  });

  it("后续同步只请求新发现的视频", async () => {
    await withRetentionFixture(async ({ configPath, store, writeInventory }) => {
      await writeInventory(["video-001", "video-002"]);
      const emptyCurve = curveResult(
        [
          { elapsedVideoTimeRatio: 0.01, audienceWatchRatio: 1 },
          { elapsedVideoTimeRatio: 0.02, audienceWatchRatio: 0.9 },
        ],
        {},
      );
      const firstProvider = new FakeRetentionProvider(
        new Map([
          ["video-001", emptyCurve],
          ["video-002", emptyCurve],
        ]),
      );
      await syncRetention(
        configPath,
        { channelId },
        {
          provider: firstProvider,
          credentialStore: store,
          now: () => new Date("2026-08-19T12:00:00.000Z"),
        },
      );

      await writeInventory(["video-001", "video-002", "video-003"]);
      const secondProvider = new FakeRetentionProvider(
        new Map([
          [
            "video-003",
            curveResult(
              [{ elapsedVideoTimeRatio: 0.01, audienceWatchRatio: 0.8 }],
              {},
            ),
          ],
        ]),
      );
      const second = await syncRetention(
        configPath,
        { channelId },
        {
          provider: secondProvider,
          credentialStore: store,
          now: () => new Date("2026-08-20T12:00:00.000Z"),
        },
      );
      expect(secondProvider.requests.map((request) => request.videoId)).toEqual(
        ["video-003"],
      );
      expect(second.state.completedVideoIds).toEqual([
        "video-001",
        "video-002",
        "video-003",
      ]);
      expect(second.state.status).toBe("completed");

      const thirdProvider = new FakeRetentionProvider(new Map());
      const third = await syncRetention(
        configPath,
        { channelId },
        {
          provider: thirdProvider,
          credentialStore: store,
          now: () => new Date("2026-08-21T12:00:00.000Z"),
        },
      );
      expect(thirdProvider.requests).toHaveLength(0);
      expect(third.state.status).toBe("completed");
    });
  });

  it("库存全部视频都缺少数据点时覆盖状态如实降级为不可用", async () => {
    await withRetentionFixture(async ({ configPath, store, writeInventory }) => {
      await writeInventory(["video-001"]);
      const provider = new FakeRetentionProvider(
        new Map([
          [
            "video-001",
            {
              points: [],
              raw: { video: "video-001" },
              coverage: "unavailable" as const,
              reason: "官方在该视频没有可用的留存曲线数据点。",
            },
          ],
        ]),
      );
      const result = await syncRetention(
        configPath,
        { channelId },
        {
          provider,
          credentialStore: store,
          now: () => new Date("2026-08-19T12:00:00.000Z"),
        },
      );
      expect(result.state.status).toBe("completed");
      expect(result.state.coverage).toBe("unavailable");
      expect(result.data.coverage).toBe("unavailable");
      expect(result.data.curves[0]).toMatchObject({
        videoId: "video-001",
        points: [],
        coverage: "unavailable",
      });
    });
  });

  it("尚无已完成的视频清单时同步任务失败且不发起官方查询", async () => {
    await withRetentionFixture(async ({ configPath, store }) => {
      const provider = new FakeRetentionProvider(new Map());
      await expect(
        syncRetention(
          configPath,
          { channelId },
          { provider, credentialStore: store },
        ),
      ).rejects.toThrow("频道基础数据同步");
      expect(provider.requests).toHaveLength(0);
    });
  });
});

describe("留存曲线读取", () => {
  it("默认读取最后可用数据并按缓存窗口标记新鲜度", async () => {
    await withRetentionFixture(async ({ configPath, store, writeInventory }) => {
      await writeInventory(["video-001"]);
      await syncRetention(
        configPath,
        { channelId },
        {
          credentialStore: store,
          provider: new FakeRetentionProvider(
            new Map([
              [
                "video-001",
                curveResult(
                  [
                    { elapsedVideoTimeRatio: 0.01, audienceWatchRatio: 1 },
                    { elapsedVideoTimeRatio: 0.02, audienceWatchRatio: 0.98 },
                  ],
                  {},
                  "2026-08-19T01:00:00.000Z",
                ),
              ],
            ]),
          ),
          now: () => new Date("2026-08-19T12:00:00.000Z"),
        },
      );

      const fresh = await readRetentionCurve(
        configPath,
        { channelId, videoId: "video-001", maxAgeHours: 24 },
        { credentialStore: store, now: () => new Date("2026-08-19T20:00:00.000Z") },
      );
      expect(fresh.mode).toBe("cached");
      expect(fresh.freshness).toBe("fresh");
      expect(fresh.stale).toBe(false);
      expect(fresh.dataAsOf).toBe("2026-08-19T01:00:00.000Z");
      expect(fresh.curve.points).toEqual([
        { elapsedVideoTimeRatio: 0.01, audienceWatchRatio: 1 },
        { elapsedVideoTimeRatio: 0.02, audienceWatchRatio: 0.98 },
      ]);
      expect(fresh.refresh).toEqual({ attempted: false, status: "not-requested" });

      const stale = await readRetentionCurve(
        configPath,
        { channelId, videoId: "video-001", maxAgeHours: 24 },
        { credentialStore: store, now: () => new Date("2026-08-20T12:00:00.000Z") },
      );
      expect(stale.freshness).toBe("stale");
      expect(stale.stale).toBe(true);
    });
  });

  it("强制最新查询在源站刷新失败时返回失败而不使用过期数据", async () => {
    await withRetentionFixture(async ({ configPath, store, writeInventory }) => {
      await writeInventory(["video-001"]);
      await syncRetention(
        configPath,
        { channelId },
        {
          credentialStore: store,
          provider: new FakeRetentionProvider(
            new Map([
              [
                "video-001",
                curveResult(
                  [{ elapsedVideoTimeRatio: 0.01, audienceWatchRatio: 1 }],
                  {},
                  "2026-08-19T01:00:00.000Z",
                ),
              ],
            ]),
          ),
          now: () => new Date("2026-08-19T12:00:00.000Z"),
        },
      );

      await expect(
        readRetentionCurve(
          configPath,
          { channelId, videoId: "video-001", mode: "latest" },
          {
            credentialStore: store,
            provider: new FakeRetentionProvider(
              new Map([
                [
                  "video-001",
                  new RetentionServiceError("配额不足。", "quota", true),
                ],
              ]),
            ),
            now: () => new Date("2026-08-20T12:00:00.000Z"),
          },
        ),
      ).rejects.toMatchObject({ kind: "quota" });

      const status = await import("../src/lib/retention.js").then((module) =>
        module.getRetentionStatus(configPath, channelId),
      );
      const curve = status.data.curves.find(
        (candidate) => candidate.videoId === "video-001",
      );
      expect(curve?.dataAsOf).toBe("2026-08-19T01:00:00.000Z");
    });
  });

  it("刷新失败时回退到最后可用数据并标记刷新失败", async () => {
    await withRetentionFixture(async ({ configPath, store, writeInventory }) => {
      await writeInventory(["video-001"]);
      await syncRetention(
        configPath,
        { channelId },
        {
          credentialStore: store,
          provider: new FakeRetentionProvider(
            new Map([
              [
                "video-001",
                curveResult(
                  [{ elapsedVideoTimeRatio: 0.01, audienceWatchRatio: 1 }],
                  {},
                  "2026-08-19T01:00:00.000Z",
                ),
              ],
            ]),
          ),
          now: () => new Date("2026-08-19T12:00:00.000Z"),
        },
      );

      const result = await readRetentionCurve(
        configPath,
        { channelId, videoId: "video-001", mode: "refresh" },
        {
          credentialStore: store,
          provider: new FakeRetentionProvider(
            new Map([
              [
                "video-001",
                new RetentionServiceError("网络连接失败。", "network", true),
              ],
            ]),
          ),
          now: () => new Date("2026-08-20T12:00:00.000Z"),
        },
      );
      expect(result.success).toBe(true);
      expect(result.stale).toBe(true);
      expect(result.curve.points).toEqual([
        { elapsedVideoTimeRatio: 0.01, audienceWatchRatio: 1 },
      ]);
      expect(result.refresh).toMatchObject({
        attempted: true,
        status: "failed",
        error: { kind: "network" },
      });
    });
  });

  it("强制最新成功时更新单视频曲线并记入已完成清单", async () => {
    await withRetentionFixture(async ({ configPath, store, writeInventory }) => {
      await writeInventory(["video-001"]);
      await syncRetention(
        configPath,
        { channelId },
        {
          credentialStore: store,
          provider: new FakeRetentionProvider(
            new Map([
              [
                "video-001",
                curveResult(
                  [{ elapsedVideoTimeRatio: 0.01, audienceWatchRatio: 1 }],
                  {},
                  "2026-08-19T01:00:00.000Z",
                ),
              ],
            ]),
          ),
          now: () => new Date("2026-08-19T12:00:00.000Z"),
        },
      );

      const result = await readRetentionCurve(
        configPath,
        { channelId, videoId: "video-001", mode: "latest" },
        {
          credentialStore: store,
          provider: new FakeRetentionProvider(
            new Map([
              [
                "video-001",
                curveResult(
                  [
                    { elapsedVideoTimeRatio: 0.01, audienceWatchRatio: 1.05 },
                    { elapsedVideoTimeRatio: 0.02, audienceWatchRatio: 0.8 },
                  ],
                  {},
                  "2026-08-20T02:00:00.000Z",
                ),
              ],
            ]),
          ),
          now: () => new Date("2026-08-20T12:00:00.000Z"),
        },
      );
      expect(result.freshness).toBe("fresh");
      expect(result.refresh).toMatchObject({ attempted: true, status: "completed" });
      expect(result.curve.points).toEqual([
        { elapsedVideoTimeRatio: 0.01, audienceWatchRatio: 1.05 },
        { elapsedVideoTimeRatio: 0.02, audienceWatchRatio: 0.8 },
      ]);
      expect(result.state.completedVideoIds).toEqual(["video-001"]);
    });
  });

  it("尚无留存曲线时默认读取失败而不虚构事实", async () => {
    await withRetentionFixture(async ({ configPath, store }) => {
      await expect(
        readRetentionCurve(
          configPath,
          { channelId, videoId: "video-001" },
          { credentialStore: store },
        ),
      ).rejects.toMatchObject({ kind: "not-ready" });
    });
  });
});

describe("留存曲线官方适配器", () => {
  it("解析留存曲线：隐私阈值空单元格省略而非置零，超过 100% 如实保留", async () => {
    const requests: string[] = [];
    const provider = new GoogleRetentionProvider(async (input) => {
      requests.push(String(input));
      return new Response(
        JSON.stringify({
          columnHeaders: [
            { name: "elapsedVideoTimeRatio", columnType: "DIMENSION" },
            { name: "audienceWatchRatio", columnType: "METRIC" },
          ],
          rows: [
            ["0.01", "1.23"],
            ["0.02", ""],
            ["0.03", 0.87],
            ["0.04", "1.18"],
          ],
        }),
        { status: 200 },
      );
    });
    const result = await provider.queryCurve({
      accessToken: "token",
      channelId,
      videoId: "video-001",
      startDate: RETENTION_FULL_HISTORY_START_DATE,
      endDate: "2026-08-19",
    });
    expect(result.points).toEqual([
      { elapsedVideoTimeRatio: 0.01, audienceWatchRatio: 1.23 },
      { elapsedVideoTimeRatio: 0.03, audienceWatchRatio: 0.87 },
      { elapsedVideoTimeRatio: 0.04, audienceWatchRatio: 1.18 },
    ]);
    expect(result.coverage).toBe("complete");
    expect(requests[0]).toContain("youtubeanalytics.googleapis.com");
    expect(requests[0]).toContain("metrics=audienceWatchRatio");
    expect(requests[0]).toContain("dimensions=elapsedVideoTimeRatio");
    expect(requests[0]).toContain("filters=video%3D%3Dvideo-001");
  });

  it("单页超过固定横轴点数时继续分页取完整曲线", async () => {
    const requests: string[] = [];
    const firstPageRows = Array.from({ length: 100 }, (_, index) => [
      String((index + 1) / 100),
      index,
    ]);
    const provider = new GoogleRetentionProvider(async (input) => {
      const url = String(input);
      requests.push(url);
      if (requests.length === 1) {
        return new Response(
          JSON.stringify({
            columnHeaders: [
              { name: "elapsedVideoTimeRatio", columnType: "DIMENSION" },
              { name: "audienceWatchRatio", columnType: "METRIC" },
            ],
            rows: firstPageRows,
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          columnHeaders: [
            { name: "elapsedVideoTimeRatio", columnType: "DIMENSION" },
            { name: "audienceWatchRatio", columnType: "METRIC" },
          ],
          rows: [["1", 999]],
        }),
        { status: 200 },
      );
    });
    const result = await provider.queryCurve({
      accessToken: "token",
      channelId,
      videoId: "video-001",
      startDate: RETENTION_FULL_HISTORY_START_DATE,
      endDate: "2026-08-19",
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("startIndex=101");
    expect(result.points).toHaveLength(101);
    expect(result.points[0]).toEqual({
      elapsedVideoTimeRatio: 0.01,
      audienceWatchRatio: 0,
    });
    expect(result.points[100]).toEqual({
      elapsedVideoTimeRatio: 1,
      audienceWatchRatio: 999,
    });
  });

  it("整个响应没有数据行时视为该视频暂无留存曲线", async () => {
    const provider = new GoogleRetentionProvider(async () =>
      new Response(
        JSON.stringify({
          columnHeaders: [
            { name: "elapsedVideoTimeRatio", columnType: "DIMENSION" },
            { name: "audienceWatchRatio", columnType: "METRIC" },
          ],
        }),
        { status: 200 },
      ),
    );
    const result = await provider.queryCurve({
      accessToken: "token",
      channelId,
      videoId: "video-001",
      startDate: RETENTION_FULL_HISTORY_START_DATE,
      endDate: "2026-08-19",
    });
    expect(result.points).toEqual([]);
    expect(result.coverage).toBe("unavailable");
  });
});
