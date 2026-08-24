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
import {
  CORE_ANALYTICS_METRICS,
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
  it("默认请求最近 365 天，并分别同步频道和视频事实", async () => {
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
      expect(provider.queries).toHaveLength(2);
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
      const evidence = await readFile(result.data.evidence[0].path, "utf8");
      expect(evidence).not.toContain("analytics-access-token-must-not-leak");
      expect(result.data.coverage).toBe("complete");
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
          1, 1,
        ]);
        expect(result.state.checkpoint).toEqual({
          channelStartIndex: 1,
          videoStartIndex: 1,
        });
        const savedState = JSON.parse(await readFile(statePath, "utf8"));
        expect(savedState.checkpoint).toEqual({
          channelStartIndex: 1,
          videoStartIndex: 1,
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
