import {
  mkdir,
  mkdtemp,
  readFile,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initializeChannelOperationsConfig } from "../src/lib/config.js";
import { updateGlobalChannelOperationsConfig } from "../src/lib/config.js";
import {
  CORE_ANALYTICS_METRICS,
  deriveAnalyticsFacts,
  type AnalyticsProvider,
  type AnalyticsProviderResult,
  type AnalyticsQuery,
  GoogleAnalyticsProvider,
  syncAnalytics,
} from "../src/lib/analytics.js";
import { AnalyticsServiceError, UserInputError } from "../src/lib/errors.js";
import { MemoryCredentialStore } from "../src/lib/oauth.js";

const channelId = "UC1111111111111111111111";
const credentialRef = "credential-ref";

class FakeAnalyticsProvider implements AnalyticsProvider {
  readonly queries: Array<AnalyticsQuery & { accessToken: string }> = [];
  private readonly results: Array<AnalyticsProviderResult | Error>;

  constructor(results: Array<AnalyticsProviderResult | Error>) {
    this.results = [...results];
  }

  async query(
    input: AnalyticsQuery & { accessToken: string },
  ): Promise<AnalyticsProviderResult> {
    this.queries.push(input);
    const result = this.results.shift();
    if (result instanceof Error) {
      throw result;
    }
    if (result === undefined) {
      throw new Error("unexpected query");
    }
    return result;
  }
}

async function withAnalyticsFixture(
  run: (fixture: {
    configPath: string;
    dataRoot: string;
    store: MemoryCredentialStore;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ytops-analytics-"));
  const configPath = join(root, "config.json");
  const dataRoot = join(root, ".ytops-data");
  const statePath = join(dataRoot, "oauth", "connections.json");
  const store = new MemoryCredentialStore();
  await initializeChannelOperationsConfig(configPath, false);
  await store.set(credentialRef, {
    accessToken: "analytics-access-token-must-not-leak",
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
          credentialRef,
          scopes: ["https://www.googleapis.com/auth/youtube.readonly"],
          connectedAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
    })}\n`,
    "utf8",
  );

  try {
    await run({ configPath, dataRoot, store });
  } finally {
    await unlink(statePath).catch(() => undefined);
    await rmdir(join(dataRoot, "oauth")).catch(() => undefined);
    await rmdir(dataRoot).catch(() => undefined);
    await unlink(configPath).catch(() => undefined);
    await rmdir(root).catch(() => undefined);
  }
}

describe("频道核心 Analytics", () => {
  it("默认请求最近 365 天,并分别同步频道、视频与画像事实", async () => {
    await withAnalyticsFixture(async ({ configPath, store }) => {
      const provider = new FakeAnalyticsProvider([
        {
          rows: [{ dimensions: { day: "2026-08-19" }, metrics: { views: 7 } }],
          raw: { source: "channel" },
          dataAsOf: "2026-08-19T01:00:00.000Z",
          coverage: "complete",
        },
        {
          rows: [{ dimensions: { video: "video-001" }, metrics: { views: 3 } }],
          raw: { source: "video" },
          coverage: "complete",
        },
        {
          rows: [
            {
              dimensions: {
                day: "2026-08-19",
                trafficSourceType: "REFERRAL",
              },
              metrics: { views: 2 },
            },
          ],
          raw: { source: "audience-traffic" },
          coverage: "complete",
        },
        {
          rows: [
            {
              dimensions: { day: "2026-08-19", country: "US" },
              metrics: { views: 4 },
            },
          ],
          raw: { source: "audience-country" },
          coverage: "complete",
        },
        {
          rows: [
            {
              dimensions: {
                day: "2026-08-19",
                ageGroup: "AGE_25_34",
                gender: "female",
              },
              metrics: { views: 1 },
            },
          ],
          raw: { source: "audience-demo" },
          coverage: "complete",
        },
        {
          rows: [
            {
              dimensions: {
                day: "2026-08-19",
                subscribedStatus: "SUBSCRIBED",
              },
              metrics: { estimatedMinutesWatched: 9 },
            },
          ],
          raw: { source: "audience-subscribed" },
          coverage: "complete",
        },
      ]);

      const result = await syncAnalytics(
        configPath,
        { channelId, videoIds: ["video-001"] },
        {
          provider,
          credentialStore: store,
          now: () => new Date("2026-08-19T12:00:00.000Z"),
        },
      );

      expect(result.state.status).toBe("completed");
      expect(result.state.requestedDays).toBe(365);
      expect(result.state.startDate).toBe("2025-08-20");
      expect(result.state.endDate).toBe("2026-08-19");
      expect(result.data.channelRows).toHaveLength(1);
      expect(result.data.videoRows).toHaveLength(1);
      expect(provider.queries).toHaveLength(6);
      expect(provider.queries[0]).toMatchObject({
        accessToken: "analytics-access-token-must-not-leak",
        channelId,
        dimensions: ["day"],
        metrics: [...CORE_ANALYTICS_METRICS],
        startIndex: 1,
      });
      expect(provider.queries[1]).toMatchObject({
        channelId,
        dimensions: ["video"],
        filters: { video: "video-001" },
        startIndex: 1,
      });
      expect(provider.queries[2]).toMatchObject({
        dimensions: ["day", "trafficSourceType"],
        startIndex: 1,
      });
      expect(provider.queries[3]).toMatchObject({
        dimensions: ["day", "country"],
      });
      expect(provider.queries[4]).toMatchObject({
        dimensions: ["day", "ageGroup", "gender"],
      });
      expect(provider.queries[5]).toMatchObject({
        dimensions: ["day", "subscribedStatus"],
      });
      expect(result.data.audienceRows).toHaveLength(4);
      const evidence = await readFile(result.data.evidence[0].path, "utf8");
      expect(evidence).not.toContain("analytics-access-token-must-not-leak");
      expect(result.data.coverage).toBe("complete");
    });
  });

  it("默认同步同时请求播放口径、互动口径与新增互动指标", async () => {
    await withAnalyticsFixture(async ({ configPath, store }) => {
      const provider = new FakeAnalyticsProvider([
        {
          rows: [{ dimensions: { day: "2026-08-19" }, metrics: { views: 7 } }],
          raw: { source: "channel" },
          coverage: "complete",
        },
        {
          rows: [{ dimensions: { video: "video-001" }, metrics: { views: 3 } }],
          raw: { source: "video" },
          coverage: "complete",
        },
      ]);

      const result = await syncAnalytics(
        configPath,
        { channelId, videoIds: ["video-001"] },
        {
          provider,
          credentialStore: store,
          now: () => new Date("2026-08-19T12:00:00.000Z"),
        },
      );

      const expectedMetrics = [
        "views",
        "engagedViews",
        "estimatedMinutesWatched",
        "averageViewDuration",
        "likes",
        "dislikes",
        "comments",
        "shares",
        "subscribersGained",
        "subscribersLost",
      ];
      expect(provider.queries[0].metrics).toEqual(expectedMetrics);
      expect(provider.queries[1].metrics).toEqual(expectedMetrics);
      expect(result.state.metrics).toEqual(expectedMetrics);
    });
  });

  it("在发起官方请求前拒绝超过 3650 天的回填", async () => {
    await withAnalyticsFixture(async ({ configPath, store }) => {
      const provider = new FakeAnalyticsProvider([]);
      await expect(
        syncAnalytics(
          configPath,
          { channelId, days: 3651 },
          { provider, credentialStore: store },
        ),
      ).rejects.toThrow("3650");
      expect(provider.queries).toHaveLength(0);
    });
  });

  it("中断后从检查点恢复，并且规范化事实不会重复", async () => {
    await withAnalyticsFixture(async ({ configPath, store }) => {
      const firstProvider = new FakeAnalyticsProvider([
        {
          rows: [{ dimensions: { day: "2026-08-18" }, metrics: { views: 1 } }],
          raw: { page: 1 },
          nextStartIndex: 201,
        },
      ]);
      const first = await syncAnalytics(
        configPath,
        { channelId, videoIds: ["video-001"] },
        {
          provider: firstProvider,
          credentialStore: store,
          maxWorkUnits: 1,
          now: () => new Date("2026-08-19T12:00:00.000Z"),
        },
      );
      expect(first.state.status).toBe("partial");
      expect(first.state.checkpoint.channelStartIndex).toBe(201);

      const secondProvider = new FakeAnalyticsProvider([
        {
          rows: [{ dimensions: { day: "2026-08-19" }, metrics: { views: 2 } }],
          raw: { page: 2 },
        },
        {
          rows: [{ dimensions: { video: "video-001" }, metrics: { views: 1 } }],
          raw: { video: true },
        },
        {
          rows: [
            {
              dimensions: {
                day: "2026-08-19",
                trafficSourceType: "REFERRAL",
              },
              metrics: { views: 1 },
            },
          ],
          raw: { audience: "traffic" },
        },
        {
          rows: [
            {
              dimensions: { day: "2026-08-19", country: "US" },
              metrics: { views: 1 },
            },
          ],
          raw: { audience: "country" },
        },
        {
          rows: [
            {
              dimensions: {
                day: "2026-08-19",
                ageGroup: "AGE_25_34",
                gender: "female",
              },
              metrics: { views: 1 },
            },
          ],
          raw: { audience: "demo" },
        },
        {
          rows: [
            {
              dimensions: {
                day: "2026-08-19",
                subscribedStatus: "SUBSCRIBED",
              },
              metrics: { views: 1 },
            },
          ],
          raw: { audience: "subscribed" },
        },
      ]);
      const second = await syncAnalytics(
        configPath,
        { channelId, videoIds: ["video-001"] },
        {
          provider: secondProvider,
          credentialStore: store,
          now: () => new Date("2026-08-19T12:00:00.000Z"),
        },
      );
      expect(second.state.status).toBe("completed");
      expect(second.data.channelRows).toHaveLength(2);
      expect(second.data.videoRows).toHaveLength(1);
      expect(second.data.audienceRows).toHaveLength(4);
      expect(secondProvider.queries[0].startIndex).toBe(201);
    });
  });

  it("将旧的零值检查点迁移为官方 API 的首个分页索引", async () => {
    await withAnalyticsFixture(async ({ configPath, dataRoot, store }) => {
      const analyticsRoot = join(dataRoot, "analytics", channelId);
      const statePath = join(analyticsRoot, "sync-state.json");
      let result: Awaited<ReturnType<typeof syncAnalytics>> | undefined;
      await mkdir(analyticsRoot, { recursive: true });
      await writeFile(
        statePath,
        `${JSON.stringify({
          version: 1,
          channelId,
          status: "partial",
          phase: "channel",
          requestedDays: 365,
          startDate: "2025-08-20",
          endDate: "2026-08-19",
          metrics: [...CORE_ANALYTICS_METRICS],
          progress: { pages: 0, rows: 0 },
          checkpoint: { channelStartIndex: 0, videoStartIndex: 0 },
          coverage: "partial",
          updatedAt: "2026-08-19T00:00:00.000Z",
        })}\n`,
        "utf8",
      );
      try {
        const provider = new FakeAnalyticsProvider([
          { rows: [], raw: { phase: "channel" } },
          { rows: [], raw: { phase: "video" } },
          { rows: [], raw: { phase: "audience-traffic" } },
          { rows: [], raw: { phase: "audience-country" } },
          { rows: [], raw: { phase: "audience-demo" } },
          { rows: [], raw: { phase: "audience-subscribed" } },
        ]);
        result = await syncAnalytics(
          configPath,
          { channelId, videoIds: [] },
          {
            provider,
            credentialStore: store,
            now: () => new Date("2026-08-19T12:00:00.000Z"),
          },
        );

        expect(provider.queries.map((query) => query.startIndex)).toEqual([
          1, 1, 1, 1, 1, 1,
        ]);
        expect(result.state.checkpoint).toEqual({
          channelStartIndex: 1,
          videoStartIndex: 1,
          audience: { group: 4, startIndex: 1 },
        });
        const savedState = JSON.parse(await readFile(statePath, "utf8"));
        expect(savedState.checkpoint).toEqual({
          channelStartIndex: 1,
          videoStartIndex: 1,
          audience: { group: 4, startIndex: 1 },
        });
      } finally {
        for (const evidence of result?.data.evidence ?? []) {
          await unlink(evidence.path).catch(() => undefined);
        }
        await unlink(join(analyticsRoot, "data.json")).catch(() => undefined);
        await unlink(statePath).catch(() => undefined);
        await rmdir(join(analyticsRoot, "evidence")).catch(() => undefined);
        await rmdir(analyticsRoot).catch(() => undefined);
        await rmdir(join(dataRoot, "analytics")).catch(() => undefined);
      }
    });
  });

  it("权限不足时保留失败原因并标记 permission-denied", async () => {
    await withAnalyticsFixture(async ({ configPath, store }) => {
      const provider = new FakeAnalyticsProvider([
        new AnalyticsServiceError(
          "当前 OAuth 授权不包含 Analytics 读取权限。",
          "permission",
          false,
        ),
      ]);
      const result = await syncAnalytics(
        configPath,
        { channelId },
        { provider, credentialStore: store },
      );
      expect(result.state.status).toBe("failed");
      expect(result.state.coverage).toBe("permission-denied");
      expect(result.state.error).toMatchObject({ kind: "permission" });
      expect(result.data.channelRows).toEqual([]);
    });
  });

  it("画像组失败不影响核心结果，并把画像覆盖标记为资格受限", async () => {
    await withAnalyticsFixture(async ({ configPath, store }) => {
      const provider = new FakeAnalyticsProvider([
        {
          rows: [{ dimensions: { day: "2026-08-19" }, metrics: { views: 7 } }],
          raw: { source: "channel" },
          coverage: "complete",
        },
        {
          rows: [{ dimensions: { video: "video-001" }, metrics: { views: 3 } }],
          raw: { source: "video" },
          coverage: "complete",
        },
        new AnalyticsServiceError(
          "当前 OAuth 授权不包含 Analytics 读取权限。",
          "permission",
          false,
        ),
        {
          rows: [
            {
              dimensions: { day: "2026-08-19", country: "US" },
              metrics: { views: 4 },
            },
          ],
          raw: { source: "audience-country" },
          coverage: "complete",
        },
        {
          rows: [
            {
              dimensions: {
                day: "2026-08-19",
                ageGroup: "AGE_25_34",
                gender: "female",
              },
              metrics: { views: 1 },
            },
          ],
          raw: { source: "audience-demo" },
          coverage: "complete",
        },
        {
          rows: [
            {
              dimensions: {
                day: "2026-08-19",
                subscribedStatus: "SUBSCRIBED",
              },
              metrics: { views: 2 },
            },
          ],
          raw: { source: "audience-subscribed" },
          coverage: "complete",
        },
      ]);
      const result = await syncAnalytics(
        configPath,
        { channelId, videoIds: ["video-001"] },
        {
          provider,
          credentialStore: store,
          now: () => new Date("2026-08-19T12:00:00.000Z"),
        },
      );
      expect(result.state.status).toBe("completed");
      expect(result.state.audienceCoverage).toBe("permission-denied");
      expect(result.state.coverage).toBe("complete");
      expect(result.data.channelRows).toHaveLength(1);
      expect(result.data.videoRows).toHaveLength(1);
      expect(result.data.audienceRows).toHaveLength(3);
      expect(
        result.data.audienceRows?.some(
          (row) => row.dimensions.trafficSourceType === "REFERRAL",
        ),
      ).toBe(false);
    });
  });

  it("未开启货币 opt-in 时同步不携带收入指标与币种，显式请求被本地拒绝", async () => {
    await withAnalyticsFixture(async ({ configPath, store }) => {
      const provider = new FakeAnalyticsProvider([
        {
          rows: [{ dimensions: { day: "2026-08-19" }, metrics: { views: 7 } }],
          raw: { source: "channel" },
          coverage: "complete",
        },
        {
          rows: [{ dimensions: { video: "video-001" }, metrics: { views: 3 } }],
          raw: { source: "video" },
          coverage: "complete",
        },
        { rows: [], raw: { source: "audience-traffic" }, coverage: "complete" },
        { rows: [], raw: { source: "audience-country" }, coverage: "complete" },
        { rows: [], raw: { source: "audience-demo" }, coverage: "complete" },
        {
          rows: [],
          raw: { source: "audience-subscribed" },
          coverage: "complete",
        },
      ]);
      const result = await syncAnalytics(
        configPath,
        { channelId, videoIds: ["video-001"] },
        {
          provider,
          credentialStore: store,
          now: () => new Date("2026-08-19T12:00:00.000Z"),
        },
      );
      expect(result.state.revenueOptIn).toBe(false);
      for (const query of [...provider.queries.slice(0, 2)]) {
        expect(query.metrics).not.toContain("estimatedRevenue");
        expect(query.currency).toBeUndefined();
      }

      const rejectedProvider = new FakeAnalyticsProvider([]);
      await expect(
        syncAnalytics(
          configPath,
          {
            channelId,
            metrics: ["estimatedRevenue" as never],
          },
          { provider: rejectedProvider, credentialStore: store },
        ),
      ).rejects.toThrow("核心指标目录");
      expect(rejectedProvider.queries).toHaveLength(0);
    });
  });

  it("开启货币 opt-in 后核心同步携带收入指标并显式 USD，画像组不受影响", async () => {
    await withAnalyticsFixture(async ({ configPath, store }) => {
      await updateGlobalChannelOperationsConfig(configPath, {
        analytics: { revenueOptIn: true },
      });
      const provider = new FakeAnalyticsProvider([
        {
          rows: [
            {
              dimensions: { day: "2026-08-19" },
              metrics: { views: 7, estimatedRevenue: 0.02 },
            },
          ],
          raw: { source: "channel" },
          coverage: "complete",
        },
        {
          rows: [
            {
              dimensions: { video: "video-001" },
              metrics: { views: 3, estimatedRevenue: 0.01 },
            },
          ],
          raw: { source: "video" },
          coverage: "complete",
        },
        { rows: [], raw: { source: "audience-traffic" }, coverage: "complete" },
        { rows: [], raw: { source: "audience-country" }, coverage: "complete" },
        { rows: [], raw: { source: "audience-demo" }, coverage: "complete" },
        {
          rows: [],
          raw: { source: "audience-subscribed" },
          coverage: "complete",
        },
      ]);
      const result = await syncAnalytics(
        configPath,
        { channelId, videoIds: ["video-001"] },
        {
          provider,
          credentialStore: store,
          now: () => new Date("2026-08-19T12:00:00.000Z"),
        },
      );
      expect(result.state.revenueOptIn).toBe(true);
      expect(provider.queries[0].metrics).toContain("estimatedRevenue");
      expect(provider.queries[0].currency).toBe("USD");
      expect(provider.queries[1].metrics).toContain("estimatedRevenue");
      expect(provider.queries[1].currency).toBe("USD");
      expect(provider.queries[2].metrics).not.toContain("estimatedRevenue");
      expect(provider.queries[2].currency).toBeUndefined();
      expect(result.data.channelRows[0].metrics.estimatedRevenue).toBe(0.02);
    });
  });

  it("RPM 与赞踩比仅在读取时派生，缺输入的行省略派生值", () => {
    const derived = deriveAnalyticsFacts([
      {
        dimensions: { day: "2026-08-19" },
        metrics: {
          estimatedRevenue: 2,
          engagedViews: 500,
          likes: 30,
          dislikes: 10,
        },
      },
      {
        dimensions: { day: "2026-08-18" },
        metrics: { estimatedRevenue: 5, engagedViews: 0 },
      },
      { dimensions: { day: "2026-08-17" }, metrics: { views: 100 } },
    ]);
    expect(derived[0].derived).toEqual({
      rpmPerThousandEngagedViews: 4,
      likeToDislikeRatio: 3,
    });
    expect(derived[1].derived).toEqual({});
    expect(derived[2].derived).toEqual({});
  });

  it("画像阶段从组检查点恢复且不重复核心阶段", async () => {
    await withAnalyticsFixture(async ({ configPath, store }) => {
      const firstProvider = new FakeAnalyticsProvider([
        {
          rows: [{ dimensions: { day: "2026-08-19" }, metrics: { views: 7 } }],
          raw: { source: "channel" },
          coverage: "complete",
        },
        {
          rows: [{ dimensions: { video: "video-001" }, metrics: { views: 3 } }],
          raw: { source: "video" },
          coverage: "complete",
        },
      ]);
      const first = await syncAnalytics(
        configPath,
        { channelId, videoIds: ["video-001"], maxWorkUnits: 2 },
        {
          provider: firstProvider,
          credentialStore: store,
          now: () => new Date("2026-08-19T12:00:00.000Z"),
        },
      );
      expect(first.state.status).toBe("partial");
      expect(first.state.phase).toBe("audience");
      expect(first.state.checkpoint.audience).toEqual({
        group: 0,
        startIndex: 1,
      });

      const secondProvider = new FakeAnalyticsProvider([
        {
          rows: [
            {
              dimensions: {
                day: "2026-08-19",
                trafficSourceType: "REFERRAL",
              },
              metrics: { views: 2 },
            },
          ],
          raw: { audience: "traffic" },
          coverage: "complete",
        },
        {
          rows: [
            {
              dimensions: { day: "2026-08-19", country: "US" },
              metrics: { views: 4 },
            },
          ],
          raw: { audience: "country" },
          coverage: "complete",
        },
        {
          rows: [
            {
              dimensions: {
                day: "2026-08-19",
                ageGroup: "AGE_25_34",
                gender: "female",
              },
              metrics: { views: 1 },
            },
          ],
          raw: { audience: "demo" },
          coverage: "complete",
        },
        {
          rows: [
            {
              dimensions: {
                day: "2026-08-19",
                subscribedStatus: "SUBSCRIBED",
              },
              metrics: { views: 2 },
            },
          ],
          raw: { audience: "subscribed" },
          coverage: "complete",
        },
      ]);
      const second = await syncAnalytics(
        configPath,
        { channelId, videoIds: ["video-001"] },
        {
          provider: secondProvider,
          credentialStore: store,
          now: () => new Date("2026-08-19T12:00:00.000Z"),
        },
      );
      expect(second.state.status).toBe("completed");
      expect(secondProvider.queries).toHaveLength(4);
      expect(secondProvider.queries[0].dimensions).toEqual([
        "day",
        "trafficSourceType",
      ]);
      expect(second.data.audienceRows).toHaveLength(4);
    });
  });

  it("Google provider 区分配额错误且不把空值转换成零", async () => {
    const requests: string[] = [];
    const provider = new GoogleAnalyticsProvider(async (input) => {
      requests.push(String(input));
      return new Response(
        JSON.stringify({
          columnHeaders: [
            { name: "day", columnType: "DIMENSION" },
            { name: "views", columnType: "METRIC" },
          ],
          rows: [["2026-08-19", ""]],
        }),
        { status: 200 },
      );
    });
    await expect(
      provider.query({
        accessToken: "must-not-enter-evidence",
        channelId,
        startDate: "2026-08-18",
        endDate: "2026-08-19",
        metrics: ["views"],
        dimensions: ["day"],
      }),
    ).resolves.toMatchObject({
      rows: [{ dimensions: { day: "2026-08-19" }, metrics: {} }],
    });
    expect(requests[0]).toContain("youtubeanalytics.googleapis.com");
  });

  it("官方请求把内部流量来源维度与筛选映射为官方名称", async () => {
    const requests: string[] = [];
    const provider = new GoogleAnalyticsProvider(async (input) => {
      requests.push(String(input));
      return new Response(
        JSON.stringify({
          columnHeaders: [
            { name: "day", columnType: "DIMENSION" },
            { name: "views", columnType: "METRIC" },
          ],
          rows: [["2026-08-19", "3"]],
        }),
        { status: 200 },
      );
    });
    await provider.query({
      accessToken: "access",
      channelId,
      startDate: "2026-08-19",
      endDate: "2026-08-19",
      metrics: ["views"],
      dimensions: ["day", "trafficSourceType"],
      filters: { trafficSourceType: "REFERRAL" },
    });
    expect(requests[0]).toContain("dimensions=day%2CinsightTrafficSourceType");
    expect(requests[0]).toContain("insightTrafficSourceType%3D%3DREFERRAL");
    expect(requests[0]).not.toContain("trafficSourceType%3D%3D");
  });

  it("Google provider 拒绝零基分页索引", async () => {
    const provider = new GoogleAnalyticsProvider(async () => {
      throw new Error("fetch must not run");
    });

    await expect(
      provider.query({
        accessToken: "token",
        channelId,
        startDate: "2026-08-18",
        endDate: "2026-08-19",
        metrics: ["views"],
        dimensions: ["day"],
        startIndex: 0,
      }),
    ).rejects.toBeInstanceOf(UserInputError);
  });
});
