import { mkdir, mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AnalyticsProvider,
  type AnalyticsProviderResult,
  type AnalyticsQuery,
  syncAnalytics,
} from "../src/lib/analytics.js";
import { readAnalyticsFacts } from "../src/lib/freshness.js";
import { AnalyticsServiceError } from "../src/lib/errors.js";
import { initializeChannelOperationsConfig } from "../src/lib/config.js";
import { MemoryCredentialStore } from "../src/lib/oauth.js";

const channelId = "UC1111111111111111111111";

class QueueProvider implements AnalyticsProvider {
  constructor(private readonly queue: Array<AnalyticsProviderResult | Error>) {}

  async query(
    _input: AnalyticsQuery & { accessToken: string },
  ): Promise<AnalyticsProviderResult> {
    const next = this.queue.shift();
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error("unexpected query");
    return next;
  }
}

async function fixture(
  run: (input: {
    configPath: string;
    store: MemoryCredentialStore;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ytops-freshness-"));
  const configPath = join(root, "config.json");
  const dataRoot = join(root, ".ytops-data");
  const statePath = join(dataRoot, "oauth", "connections.json");
  const store = new MemoryCredentialStore();
  await initializeChannelOperationsConfig(configPath, false);
  await store.set("credential-ref", {
    accessToken: "access-token",
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
  try {
    await run({ configPath, store });
  } finally {
    await unlink(statePath).catch(() => undefined);
    await rmdir(join(dataRoot, "oauth")).catch(() => undefined);
    await rmdir(dataRoot).catch(() => undefined);
    await unlink(configPath).catch(() => undefined);
    await rmdir(root).catch(() => undefined);
  }
}

describe("Analytics 新鲜度与回退", () => {
  it("默认读取最后可用数据并标记过期，刷新失败时仍返回旧数据", async () => {
    await fixture(async ({ configPath, store }) => {
      await syncAnalytics(
        configPath,
        { channelId },
        {
          credentialStore: store,
          provider: new QueueProvider([
            {
              rows: [
                { dimensions: { day: "2026-08-01" }, metrics: { views: 2 } },
              ],
              raw: {},
              coverage: "complete",
              dataAsOf: "2026-08-01T00:00:00.000Z",
            },
          ]),
          now: () => new Date("2026-08-01T00:00:00.000Z"),
        },
      );

      const cached = await readAnalyticsFacts(
        configPath,
        { channelId, maxAgeHours: 24 },
        {
          credentialStore: store,
          now: () => new Date("2026-08-03T00:00:00.000Z"),
        },
      );
      expect(cached.freshness).toBe("stale");
      expect(cached.refresh).toMatchObject({ attempted: false });

      const refreshed = await readAnalyticsFacts(
        configPath,
        { channelId, mode: "refresh" },
        {
          credentialStore: store,
          provider: new QueueProvider([
            new AnalyticsServiceError("配额不足", "quota", true),
          ]),
          now: () => new Date("2026-08-03T00:00:00.000Z"),
        },
      );
      expect(refreshed.success).toBe(true);
      expect(refreshed.stale).toBe(true);
      expect(refreshed.data.channelRows).toHaveLength(1);
      expect(refreshed.refresh).toMatchObject({
        attempted: true,
        status: "failed",
        error: { kind: "quota" },
      });
    });
  });

  it("强制最新刷新失败时不回退到陈旧数据", async () => {
    await fixture(async ({ configPath, store }) => {
      await expect(
        readAnalyticsFacts(
          configPath,
          { channelId, mode: "latest" },
          {
            credentialStore: store,
            provider: new QueueProvider([
              new AnalyticsServiceError("权限不足", "permission", false),
            ]),
          },
        ),
      ).rejects.toMatchObject({
        kind: "permission",
      });
    });
  });

  it("强制最新不会把没有事实行的官方响应报告为成功", async () => {
    await fixture(async ({ configPath, store }) => {
      await expect(
        readAnalyticsFacts(
          configPath,
          { channelId, mode: "latest" },
          {
            credentialStore: store,
            provider: new QueueProvider([
              { rows: [], raw: {}, coverage: "unavailable" },
              { rows: [], raw: {}, coverage: "unavailable" },
            ]),
          },
        ),
      ).rejects.toMatchObject({ kind: "not-ready" });
    });
  });
});
