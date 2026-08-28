import { mkdir, mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
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

async function cleanupFixture(root: string, configPath: string): Promise<void> {
  await unlink(join(root, ".ytops-data", "oauth", "connections.json")).catch(
    () => undefined,
  );
  await rmdir(join(root, ".ytops-data", "oauth")).catch(() => undefined);
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
            capability: "comments.readonly",
            status: "unavailable",
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
});
