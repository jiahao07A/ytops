import { mkdir, mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { initializeChannelOperationsConfig } from "../src/lib/config.js";
import {
  queryBreakdown,
  validateBreakdownQuery,
} from "../src/lib/breakdowns.js";
import { MemoryCredentialStore } from "../src/lib/oauth.js";

const channelId = "UC1111111111111111111111";

async function withBreakdownFixture(
  run: (input: {
    configPath: string;
    dataRoot: string;
    store: MemoryCredentialStore;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ytops-breakdown-"));
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
    await run({ configPath, dataRoot, store });
  } finally {
    await unlink(statePath).catch(() => undefined);
    await rmdir(join(dataRoot, "oauth")).catch(() => undefined);
    await rmdir(dataRoot).catch(() => undefined);
    await unlink(configPath).catch(() => undefined);
    await rmdir(root).catch(() => undefined);
  }
}

describe("高维 Analytics 配置档案", () => {
  it("在执行前拒绝不支持的指标组合和超长范围", () => {
    expect(() =>
      validateBreakdownQuery({
        metrics: ["views"],
        dimensions: ["not-supported" as "day"],
        startDate: "2026-01-01",
        endDate: "2026-01-02",
        filters: {},
      }),
    ).toThrow("不支持");

    expect(() =>
      validateBreakdownQuery({
        metrics: ["views"],
        dimensions: ["day"],
        startDate: "2010-01-01",
        endDate: "2026-01-02",
        filters: {},
      }),
    ).toThrow("3650");

    expect(() =>
      validateBreakdownQuery({
        metrics: ["views"],
        dimensions: ["video", "ageGroup"],
        startDate: "2026-01-01",
        endDate: "2026-01-02",
        filters: {},
      }),
    ).toThrow("受众维度");

    expect(() =>
      validateBreakdownQuery({
        metrics: ["estimatedRevenue"],
        dimensions: ["video"],
        startDate: "2026-01-01",
        endDate: "2026-01-02",
        filters: {},
      }),
    ).toThrow("收入估算");
  });

  it("收入资格不足时标记 permission-denied，不调用官方适配器", async () => {
    let called = false;
    const result = await queryBreakdown(
      "missing-config.json",
      {
        channelId: "UC1111111111111111111111",
        profile: {
          metrics: ["estimatedRevenue"],
          dimensions: ["day"],
          startDate: "2026-08-01",
          endDate: "2026-08-01",
          filters: {},
        },
        revenueEligible: false,
      },
      {
        provider: {
          query: async () => {
            called = true;
            return { rows: [], raw: {} };
          },
        },
      },
    );
    expect(result).toMatchObject({
      success: false,
      coverage: "permission-denied",
    });
    expect(called).toBe(false);
  });

  it("注入官方适配器后执行真实查询路径", async () => {
    await withBreakdownFixture(async ({ configPath, dataRoot, store }) => {
      let requestedAccessToken: string | undefined;
      const result = await queryBreakdown(
        configPath,
        {
          channelId,
          profile: {
            metrics: ["views"],
            dimensions: ["day"],
            startDate: "2026-08-19",
            endDate: "2026-08-19",
            filters: {},
          },
        },
        {
          credentialStore: store,
          provider: {
            query: async (input) => {
              requestedAccessToken = input.accessToken;
              return {
                rows: [
                  {
                    dimensions: { day: "2026-08-19" },
                    metrics: { views: 7 },
                  },
                ],
                raw: {},
              };
            },
          },
        },
      );

      expect(requestedAccessToken).toBe("access-token");
      expect(result).toMatchObject({
        success: true,
        coverage: "complete",
        rows: [{ dimensions: { day: "2026-08-19" }, metrics: { views: 7 } }],
      });
      if (result.evidencePath !== undefined) {
        const evidenceDirectory = dirname(result.evidencePath);
        const resultDirectory = dirname(evidenceDirectory);
        await unlink(result.evidencePath).catch(() => undefined);
        await unlink(join(resultDirectory, "result.json")).catch(
          () => undefined,
        );
        await rmdir(evidenceDirectory).catch(() => undefined);
        await rmdir(resultDirectory).catch(() => undefined);
        await rmdir(join(dataRoot, "breakdowns", channelId)).catch(
          () => undefined,
        );
        await rmdir(join(dataRoot, "breakdowns")).catch(() => undefined);
      }
    });
  });
});
