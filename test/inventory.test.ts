import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  beginChannelOAuth,
  completeChannelOAuth,
  MemoryCredentialStore,
  OAuthTokenRefreshError,
  selectChannelConnection,
  type ChannelSummary,
  type OAuthProvider,
  type OAuthToken,
} from "../src/lib/oauth.js";
import {
  GoogleInventoryProvider,
  getInventoryStatus,
  syncInventory,
  type InventoryProvider,
  type InventoryVideo,
  type InventoryUploadItem,
} from "../src/lib/inventory.js";
import { initializeChannelOperationsConfig } from "../src/lib/config.js";
import { InventoryServiceError } from "../src/lib/errors.js";

const channel: ChannelSummary = {
  id: "UC1111111111111111111111",
  title: "主频道",
  uploadsPlaylistId: "UU1111111111111111111111",
};

class FakeOAuthProvider implements OAuthProvider {
  createAuthorizationUrl(input: {
    state: string;
    redirectUri: string;
    clientId: string;
    scopes: readonly string[];
  }): string {
    return `https://example.test/oauth?state=${encodeURIComponent(input.state)}`;
  }

  async exchangeCode(input: {
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string;
  }): Promise<OAuthToken> {
    expect(input.code).toBe("authorization-code");
    expect(input.clientSecret).toBe("client-secret");
    return {
      accessToken: "inventory-access-token",
      refreshToken: "inventory-refresh-token",
      expiresAt: "2035-01-01T00:00:00.000Z",
    };
  }

  async listChannels(input: {
    accessToken: string;
  }): Promise<ChannelSummary[]> {
    expect(input.accessToken).toBe("inventory-access-token");
    return [channel];
  }
}

class FakeInventoryProvider implements InventoryProvider {
  failOnPageToken: string | undefined;
  uploadCalls: string[] = [];

  async listChannel(input: {
    accessToken: string;
    channelId: string;
  }): Promise<{
    item: {
      id: string;
      title: string;
      uploadsPlaylistId: string;
      fetchedAt: string;
    };
    raw: unknown;
  }> {
    expect(input.accessToken).toBe("inventory-access-token");
    return {
      item: {
        id: input.channelId,
        title: "主频道",
        uploadsPlaylistId: channel.uploadsPlaylistId as string,
        fetchedAt: "ignored",
      },
      raw: { id: input.channelId, title: "主频道" },
    };
  }

  async listUploads(input: {
    accessToken: string;
    playlistId: string;
    pageToken?: string;
  }): Promise<{
    items: InventoryUploadItem[];
    nextPageToken?: string;
    raw: unknown;
  }> {
    expect(input.accessToken).toBe("inventory-access-token");
    this.uploadCalls.push(input.pageToken ?? "first");
    if (
      this.failOnPageToken !== undefined &&
      this.failOnPageToken === input.pageToken
    ) {
      throw new Error("simulated network interruption");
    }
    const firstPage: InventoryUploadItem[] = [
      {
        playlistItemId: "PLITEM001",
        videoId: "VIDEO000001",
        title: "第一条视频",
        position: 0,
        fetchedAt: "ignored",
      },
    ];
    const secondPage: InventoryUploadItem[] = [
      {
        playlistItemId: "PLITEM002",
        videoId: "VIDEO000002",
        title: "第二条视频",
        position: 1,
        fetchedAt: "ignored",
      },
    ];
    return input.pageToken === undefined
      ? { items: firstPage, nextPageToken: "page-2", raw: { page: 1 } }
      : { items: secondPage, raw: { page: 2 } };
  }

  async listVideos(input: {
    accessToken: string;
    videoIds: string[];
  }): Promise<{ items: InventoryVideo[]; raw: unknown }> {
    expect(input.accessToken).toBe("inventory-access-token");
    return {
      items: input.videoIds.map((id) => ({
        id,
        title: `视频 ${id}`,
        fetchedAt: "ignored",
      })),
      raw: { ids: input.videoIds },
    };
  }
}

class TerminalInventoryProvider extends FakeInventoryProvider {
  override async listUploads(): Promise<never> {
    throw new InventoryServiceError(
      "目标频道拒绝读取上传清单。",
      "permission",
      false,
    );
  }
}

class SingleItemInventoryProvider extends FakeInventoryProvider {
  override async listUploads(input: {
    accessToken: string;
    playlistId: string;
    pageToken?: string;
  }): Promise<{
    items: InventoryUploadItem[];
    raw: unknown;
  }> {
    expect(input.accessToken).toBe("inventory-access-token");
    expect(input.pageToken).toBeUndefined();
    this.uploadCalls.push("first");
    return {
      items: [
        {
          playlistItemId: "PLITEM001",
          videoId: "VIDEO000001",
          title: "第一条视频（更新）",
          position: 0,
          fetchedAt: "ignored",
        },
      ],
      raw: { page: 1, complete: true },
    };
  }
}

class RetryableInventoryProvider extends FakeInventoryProvider {
  override async listChannel(): Promise<never> {
    throw new InventoryServiceError(
      "官方频道元数据暂时不可用。",
      "network",
      true,
    );
  }
}

async function removeTree(path: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(path);
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = join(path, entry);
    try {
      await unlink(child);
    } catch {
      await removeTree(child);
      await rmdir(child).catch(() => undefined);
    }
  }
  await rmdir(path).catch(() => undefined);
}

async function withInventoryFixture(
  run: (input: {
    configPath: string;
    root: string;
    store: MemoryCredentialStore;
    provider: FakeInventoryProvider;
    connectionId: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ytops-inventory-"));
  const configPath = join(root, "config.json");
  const store = new MemoryCredentialStore();
  const oauthProvider = new FakeOAuthProvider();
  const provider = new FakeInventoryProvider();
  try {
    await initializeChannelOperationsConfig(configPath, false);
    await beginChannelOAuth(
      configPath,
      {
        clientId: "client-id",
        redirectUri: "http://127.0.0.1:8765/oauth2callback",
      },
      {
        provider: oauthProvider,
        credentialStore: store,
        stateFactory: () => "inventory-state-token",
      },
    );
    await completeChannelOAuth(
      configPath,
      {
        code: "authorization-code",
        state: "inventory-state-token",
        clientSecret: "client-secret",
      },
      { provider: oauthProvider, credentialStore: store },
    );
    const connectionStatus = await selectChannelConnection(
      configPath,
      channel.id,
      {
        credentialStore: store,
      },
    );
    const connection = connectionStatus.connections.find(
      (candidate) => candidate.channelId === channel.id,
    );
    if (connection === undefined) {
      throw new Error("fixture did not create a channel connection");
    }
    await run({
      configPath,
      root,
      store,
      provider,
      connectionId: connection.connectionId,
    });
  } finally {
    await removeTree(join(root, ".ytops-data"));
    await unlink(configPath).catch(() => undefined);
    await rmdir(root).catch(() => undefined);
  }
}

describe("可恢复基础数据同步", () => {
  it("拒绝把缺少 items 的 2xx channel 响应当作频道不存在", async () => {
    const provider = new GoogleInventoryProvider(async () =>
      Promise.resolve(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(
      provider.listChannel({
        accessToken: "token",
        channelId: channel.id,
      }),
    ).rejects.toMatchObject({ kind: "invalid-response", retryable: false });
  });

  it("拒绝 channel items 数组中的非对象条目", async () => {
    const provider = new GoogleInventoryProvider(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ items: [null] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(
      provider.listChannel({
        accessToken: "token",
        channelId: channel.id,
      }),
    ).rejects.toMatchObject({ kind: "invalid-response", retryable: false });
  });

  it("拒绝用请求频道 ID 补造缺少稳定标识的 channel 条目", async () => {
    const provider = new GoogleInventoryProvider(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            items: [
              {
                snippet: { title: "主频道" },
                contentDetails: {
                  relatedPlaylists: {
                    uploads: channel.uploadsPlaylistId,
                  },
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    await expect(
      provider.listChannel({
        accessToken: "token",
        channelId: channel.id,
      }),
    ).rejects.toMatchObject({ kind: "invalid-response", retryable: false });
  });

  it("拒绝 channel 条目的空标题", async () => {
    const provider = new GoogleInventoryProvider(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            items: [{ id: channel.id, snippet: { title: " " } }],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    await expect(
      provider.listChannel({
        accessToken: "token",
        channelId: channel.id,
      }),
    ).rejects.toMatchObject({ kind: "invalid-response", retryable: false });
  });

  it("畸形分页令牌不会被当作完整快照并删除旧数据", async () => {
    await withInventoryFixture(async ({ configPath, store, provider }) => {
      const initial = await syncInventory(
        configPath,
        { channelId: channel.id },
        { provider, credentialStore: store },
      );
      expect(initial.data.uploads).toHaveLength(2);
      expect(initial.data.videos).toHaveLength(2);

      const malformedProvider = new GoogleInventoryProvider(async (input) => {
        const url = new URL(input);
        if (url.pathname.endsWith("/channels")) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: channel.id,
                  snippet: { title: "主频道" },
                  contentDetails: {
                    relatedPlaylists: {
                      uploads: channel.uploadsPlaylistId,
                    },
                  },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.pathname.endsWith("/playlistItems")) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: "PLITEM001",
                  snippet: { title: "第一条视频" },
                  contentDetails: { videoId: "VIDEO000001" },
                },
              ],
              nextPageToken: 42,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "VIDEO000001",
                snippet: { title: "第一条视频" },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      const result = await syncInventory(
        configPath,
        { channelId: channel.id },
        { provider: malformedProvider, credentialStore: store },
      );

      expect(result.state.status).toBe("partial");
      expect(result.task).toMatchObject({
        status: "failed",
        error: { kind: "invalid-response", retryable: false },
      });
      expect(result.data.uploads).toHaveLength(2);
      expect(result.data.videos).toHaveLength(2);
    });
  });

  it("拒绝把缺少 items 的 2xx uploads 响应当作空快照", async () => {
    const provider = new GoogleInventoryProvider(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ nextPageToken: "page-2" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(
      provider.listUploads({
        accessToken: "token",
        playlistId: "UU1111111111111111111111",
      }),
    ).rejects.toMatchObject({ kind: "invalid-response", retryable: false });
  });

  it("拒绝静默跳过缺少稳定标识的 uploads 条目", async () => {
    const provider = new GoogleInventoryProvider(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ items: [{}] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(
      provider.listUploads({
        accessToken: "token",
        playlistId: "UU1111111111111111111111",
      }),
    ).rejects.toMatchObject({ kind: "invalid-response", retryable: false });
  });

  it("拒绝 uploads 条目的空稳定标识和空标题", async () => {
    const provider = new GoogleInventoryProvider(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            items: [
              {
                id: "",
                snippet: { title: " " },
                contentDetails: { videoId: "" },
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    await expect(
      provider.listUploads({
        accessToken: "token",
        playlistId: "UU1111111111111111111111",
      }),
    ).rejects.toMatchObject({ kind: "invalid-response", retryable: false });
  });

  it("拒绝把缺少 items 的 2xx videos 响应当作空快照", async () => {
    const provider = new GoogleInventoryProvider(async () =>
      Promise.resolve(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(
      provider.listVideos({
        accessToken: "token",
        videoIds: ["VIDEO000001"],
      }),
    ).rejects.toMatchObject({ kind: "invalid-response", retryable: false });
  });

  it("拒绝静默跳过缺少稳定标识的 videos 条目", async () => {
    const provider = new GoogleInventoryProvider(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ items: [{}] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(
      provider.listVideos({
        accessToken: "token",
        videoIds: ["VIDEO000001"],
      }),
    ).rejects.toMatchObject({ kind: "invalid-response", retryable: false });
  });

  it("拒绝 videos 条目的空稳定标识和空标题", async () => {
    const provider = new GoogleInventoryProvider(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            items: [{ id: "", snippet: { title: " " } }],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    await expect(
      provider.listVideos({
        accessToken: "token",
        videoIds: ["VIDEO000001"],
      }),
    ).rejects.toMatchObject({ kind: "invalid-response", retryable: false });
  });

  it("通过统一任务投影公开稳定身份和完成状态", async () => {
    await withInventoryFixture(
      async ({ configPath, store, provider, connectionId }) => {
        const result = await syncInventory(
          configPath,
          {
            channelId: channel.id,
            scope: { channel: true, uploads: false, videos: false },
          },
          { provider, credentialStore: store },
        );

        expect(connectionId).not.toBe(channel.id);
        expect(result.task).toEqual({
          id: `youtube-data-api:${connectionId}:channel`,
          identity: {
            id: `youtube-data-api:${connectionId}:channel`,
            channelConnectionId: connectionId,
            source: "youtube-data-api",
            scope: ["channel"],
          },
          status: "completed",
          startedAt: expect.any(String),
          updatedAt: expect.any(String),
          completedAt: expect.any(String),
          lastSuccessAt: expect.any(String),
          dataAsOf: expect.any(String),
          retryable: false,
        });
      },
    );
  });

  it("按同步范围隔离任务状态、检查点和规范化结果", async () => {
    await withInventoryFixture(
      async ({ configPath, store, provider, connectionId }) => {
        const channelScope = {
          channel: true,
          uploads: false,
          videos: false,
        };
        await syncInventory(
          configPath,
          { channelId: channel.id, scope: channelScope },
          { provider, credentialStore: store },
        );
        await syncInventory(
          configPath,
          { channelId: channel.id },
          { provider, credentialStore: store },
        );

        const channelTask = await getInventoryStatus(configPath, channel.id, {
          scope: channelScope,
        });
        const fullTask = await getInventoryStatus(configPath, channel.id);

        expect(channelTask.task.id).toBe(
          `youtube-data-api:${connectionId}:channel`,
        );
        expect(channelTask.data.uploads).toEqual([]);
        expect(channelTask.state.checkpoint.videoIds).toEqual([]);
        expect(fullTask.task.id).toBe(
          `youtube-data-api:${connectionId}:channel+uploads+videos`,
        );
        expect(fullTask.data.uploads).toHaveLength(2);
        expect(fullTask.state.checkpoint.videoIds).toEqual([
          "VIDEO000001",
          "VIDEO000002",
        ]);
      },
    );
  });

  it("拒绝无法独立发现视频 ID 的 videos 范围", async () => {
    await withInventoryFixture(async ({ configPath, store, provider }) => {
      await expect(
        syncInventory(
          configPath,
          {
            channelId: channel.id,
            scope: { channel: false, uploads: false, videos: true },
          },
          { provider, credentialStore: store },
        ),
      ).rejects.toThrow("videos 范围必须同时包含 uploads");
      expect(provider.uploadCalls).toEqual([]);
    });
  });

  it("幂等迁移旧版非默认范围并在后续完整同步后保留结果", async () => {
    await withInventoryFixture(
      async ({ configPath, root, store, provider, connectionId }) => {
        const legacyRoot = join(root, ".ytops-data", "inventory", channel.id);
        await mkdir(legacyRoot, { recursive: true });
        await writeFile(
          join(legacyRoot, "sync-state.json"),
          `${JSON.stringify({
            version: 1,
            channelId: channel.id,
            status: "completed",
            scope: { channel: true, uploads: false, videos: false },
            phase: "complete",
            progress: { pages: 0, items: 1, videoItems: 0 },
            checkpoint: { videoIndex: 0, videoIds: [] },
            startedAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:01:00.000Z",
            lastSuccessAt: "2026-08-01T00:01:00.000Z",
            dataAsOf: "2026-08-01T00:01:00.000Z",
          })}\n`,
          "utf8",
        );
        await writeFile(
          join(legacyRoot, "data.json"),
          `${JSON.stringify({
            version: 1,
            channelId: channel.id,
            source: "youtube-data-api",
            channel: {
              id: channel.id,
              title: "旧版频道快照",
              fetchedAt: "2026-08-01T00:01:00.000Z",
            },
            uploads: [],
            videos: [],
            updatedAt: "2026-08-01T00:01:00.000Z",
            dataAsOf: "2026-08-01T00:01:00.000Z",
          })}\n`,
          "utf8",
        );
        const channelScope = {
          channel: true,
          uploads: false,
          videos: false,
        };

        const migrated = await getInventoryStatus(configPath, channel.id, {
          scope: channelScope,
        });
        expect(migrated.state).toMatchObject({
          version: 2,
          channelConnectionId: connectionId,
        });
        expect(migrated.task.status).toBe("completed");
        expect(migrated.data.channel?.title).toBe("旧版频道快照");
        const originalLegacyState = JSON.parse(
          await readFile(join(legacyRoot, "sync-state.json"), "utf8"),
        ) as { version: number; channelConnectionId?: string };
        expect(originalLegacyState).toEqual(
          expect.objectContaining({ version: 1 }),
        );
        expect(originalLegacyState.channelConnectionId).toBeUndefined();

        await syncInventory(
          configPath,
          { channelId: channel.id },
          { provider, credentialStore: store },
        );
        const retained = await getInventoryStatus(configPath, channel.id, {
          scope: channelScope,
        });
        expect(retained.data.channel?.title).toBe("旧版频道快照");
        expect(retained.task.id).toBe(
          `youtube-data-api:${connectionId}:channel`,
        );
      },
    );
  });

  it("同一频道的新 connectionId 不复用旧任务状态或数据", async () => {
    await withInventoryFixture(
      async ({ configPath, root, store, provider, connectionId }) => {
        const initial = await syncInventory(
          configPath,
          { channelId: channel.id },
          { provider, credentialStore: store },
        );
        expect(initial.task.identity.channelConnectionId).toBe(connectionId);
        expect(initial.data.uploads).toHaveLength(2);

        const oauthStatePath = join(
          root,
          ".ytops-data",
          "oauth",
          "connections.json",
        );
        const oauthState = JSON.parse(
          await readFile(oauthStatePath, "utf8"),
        ) as { connections: Array<{ connectionId: string }> };
        oauthState.connections[0].connectionId = "replacement-connection-id";
        await writeFile(
          oauthStatePath,
          `${JSON.stringify(oauthState, null, 2)}\n`,
          "utf8",
        );

        const replacement = await getInventoryStatus(configPath, channel.id);
        expect(replacement.task).toMatchObject({
          status: "queued",
          identity: {
            channelConnectionId: "replacement-connection-id",
          },
        });
        expect(replacement.data.uploads).toEqual([]);
        expect(replacement.data.videos).toEqual([]);

        const oldStatePath = join(
          root,
          ".ytops-data",
          "inventory",
          channel.id,
          "connections",
          encodeURIComponent(connectionId),
          "tasks",
          "youtube-data-api",
          "channel+uploads+videos",
          "sync-state.json",
        );
        const oldState = JSON.parse(await readFile(oldStatePath, "utf8")) as {
          channelConnectionId: string;
        };
        expect(oldState.channelConnectionId).toBe(connectionId);
      },
    );
  });

  it("旧版 legacy 数据迁移后禁止同频道新接入再次复用", async () => {
    await withInventoryFixture(
      async ({ configPath, root, store, provider, connectionId }) => {
        const legacyRoot = join(root, ".ytops-data", "inventory", channel.id);
        await mkdir(legacyRoot, { recursive: true });
        await writeFile(
          join(legacyRoot, "sync-state.json"),
          `${JSON.stringify({
            version: 1,
            channelId: channel.id,
            status: "completed",
            scope: { channel: true, uploads: true, videos: true },
            phase: "complete",
            progress: { pages: 1, items: 2, videoItems: 2 },
            checkpoint: {
              videoIndex: 2,
              videoIds: ["VIDEO000001", "VIDEO000002"],
            },
            updatedAt: "2026-08-01T00:01:00.000Z",
          })}\n`,
          "utf8",
        );
        await writeFile(
          join(legacyRoot, "data.json"),
          `${JSON.stringify({
            version: 1,
            channelId: channel.id,
            source: "youtube-data-api",
            channel: {
              id: channel.id,
              title: "旧版频道快照",
              fetchedAt: "2026-08-01T00:01:00.000Z",
            },
            uploads: [],
            videos: [],
            updatedAt: "2026-08-01T00:01:00.000Z",
            dataAsOf: "2026-08-01T00:01:00.000Z",
          })}\n`,
          "utf8",
        );

        const migrated = await getInventoryStatus(configPath, channel.id);
        expect(migrated.task.identity.channelConnectionId).toBe(connectionId);
        expect(migrated.data.channel?.title).toBe("旧版频道快照");
        expect(
          JSON.parse(
            await readFile(join(legacyRoot, "migration.json"), "utf8"),
          ),
        ).toEqual({
          version: 1,
          channelId: channel.id,
          channelConnectionId: connectionId,
        });

        const oauthStatePath = join(
          root,
          ".ytops-data",
          "oauth",
          "connections.json",
        );
        const oauthState = JSON.parse(
          await readFile(oauthStatePath, "utf8"),
        ) as { connections: Array<{ connectionId: string }> };
        oauthState.connections[0].connectionId = "replacement-connection-id";
        await writeFile(
          oauthStatePath,
          `${JSON.stringify(oauthState, null, 2)}\n`,
          "utf8",
        );

        await expect(
          getInventoryStatus(configPath, channel.id),
        ).rejects.toThrow("旧版 Inventory 数据已绑定其他频道接入");
        expect(provider.uploadCalls).toEqual([]);
        expect(store).toBeDefined();
      },
    );
  });

  it("部分数据后的不可重试错误仍投影为终止 failed", async () => {
    await withInventoryFixture(async ({ configPath, store }) => {
      const result = await syncInventory(
        configPath,
        { channelId: channel.id },
        {
          provider: new TerminalInventoryProvider(),
          credentialStore: store,
        },
      );

      expect(result.data.channel?.title).toBe("主频道");
      expect(result.state.status).toBe("partial");
      expect(result.task).toMatchObject({
        status: "failed",
        retryable: false,
        error: {
          kind: "permission",
          message: "目标频道拒绝读取上传清单。",
          retryable: false,
        },
      });
    });
  });

  it("保留确定性 OAuth 刷新错误的 kind 和 retryable", async () => {
    await withInventoryFixture(
      async ({ configPath, root, store, provider }) => {
        const oauthState = JSON.parse(
          await readFile(
            join(root, ".ytops-data", "oauth", "connections.json"),
            "utf8",
          ),
        ) as { connections: Array<{ credentialRef: string }> };
        const credentialRef = oauthState.connections[0].credentialRef;
        const currentToken = await store.get(credentialRef);
        expect(currentToken).toBeDefined();
        await store.set(credentialRef, {
          ...(currentToken as OAuthToken),
          expiresAt: "2020-01-01T00:00:00.000Z",
        });

        const result = await syncInventory(
          configPath,
          { channelId: channel.id },
          {
            provider,
            credentialStore: store,
            now: () => new Date("2026-08-27T00:00:00.000Z"),
            tokenRefreshProvider: {
              async refreshAccessToken() {
                throw new OAuthTokenRefreshError(
                  "Google 已拒绝刷新令牌。",
                  "invalid-grant",
                  false,
                );
              },
            },
          },
        );

        expect(result.task.error?.message).toBe("Google 已拒绝刷新令牌。");
        expect(result.task).toMatchObject({
          status: "failed",
          retryable: false,
          error: {
            kind: "invalid-grant",
            retryable: false,
          },
        });
        expect(provider.uploadCalls).toEqual([]);
      },
    );
  });

  it("拒绝读取与目标 scope 不一致的持久化任务状态", async () => {
    await withInventoryFixture(async ({ configPath, root }) => {
      const channelTaskRoot = join(
        root,
        ".ytops-data",
        "inventory",
        channel.id,
        "tasks",
        "youtube-data-api",
        "channel",
      );
      await mkdir(channelTaskRoot, { recursive: true });
      await writeFile(
        join(channelTaskRoot, "sync-state.json"),
        `${JSON.stringify({
          version: 1,
          channelId: channel.id,
          status: "not-started",
          scope: { channel: true, uploads: true, videos: true },
          phase: "channels",
          progress: { pages: 0, items: 0, videoItems: 0 },
          checkpoint: { videoIndex: 0, videoIds: [] },
          updatedAt: "2026-08-01T00:00:00.000Z",
        })}\n`,
        "utf8",
      );

      await expect(
        getInventoryStatus(configPath, channel.id, {
          scope: { channel: true, uploads: false, videos: false },
        }),
      ).rejects.toThrow("频道或范围不一致");
    });
  });

  it("有效的 scope 专用任务不受无关旧根状态损坏影响", async () => {
    await withInventoryFixture(
      async ({ configPath, root, store, provider, connectionId }) => {
        const channelScope = {
          channel: true,
          uploads: false,
          videos: false,
        };
        await syncInventory(
          configPath,
          { channelId: channel.id, scope: channelScope },
          { provider, credentialStore: store },
        );
        const legacyRoot = join(root, ".ytops-data", "inventory", channel.id);
        await writeFile(
          join(legacyRoot, "sync-state.json"),
          "{not-valid-json\n",
          "utf8",
        );

        const status = await getInventoryStatus(configPath, channel.id, {
          scope: channelScope,
        });
        expect(status.task.status).toBe("completed");
        expect(status.data.channel?.title).toBe("主频道");
      },
    );
  });

  it("保存频道、上传清单、视频、原始证据和完成状态", async () => {
    await withInventoryFixture(
      async ({ configPath, root, store, provider, connectionId }) => {
        const result = await syncInventory(
          configPath,
          { channelId: channel.id },
          { provider, credentialStore: store },
        );
        expect(result.state.status).toBe("completed");
        expect(result.state.phase).toBe("complete");
        expect(result.data.channel?.uploadsPlaylistId).toBe(
          channel.uploadsPlaylistId,
        );
        expect(result.data.uploads).toHaveLength(2);
        expect(result.data.videos).toHaveLength(2);
        expect(result.state.checkpoint.videoIds).toEqual([
          "VIDEO000001",
          "VIDEO000002",
        ]);
        const evidenceRoot = join(
          root,
          ".ytops-data",
          "inventory",
          channel.id,
          "connections",
          encodeURIComponent(connectionId),
          "tasks",
          "youtube-data-api",
          "channel+uploads+videos",
          "evidence",
        );
        expect(await readdir(evidenceRoot)).toHaveLength(4);
        const evidence = await readFile(
          join(evidenceRoot, (await readdir(evidenceRoot))[0]),
          "utf8",
        );
        expect(evidence).not.toContain("inventory-access-token");
        expect(evidence).toContain("youtube-data-api");
      },
    );
  });

  it("同一任务并发执行时返回可重试 busy 且不覆盖运行状态", async () => {
    await withInventoryFixture(async ({ configPath, store, provider }) => {
      let releaseChannel: (() => void) | undefined;
      const channelBlocked = new Promise<void>((resolve) => {
        releaseChannel = resolve;
      });
      const originalListChannel = provider.listChannel.bind(provider);
      provider.listChannel = async (input) => {
        const result = await originalListChannel(input);
        await channelBlocked;
        return result;
      };

      const first = syncInventory(
        configPath,
        { channelId: channel.id },
        { provider, credentialStore: store },
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      const competing = await syncInventory(
        configPath,
        { channelId: channel.id },
        { provider, credentialStore: store },
      );

      expect(competing.task.error).toMatchObject({
        kind: "busy",
        retryable: true,
      });
      expect(competing.task.status).toBe("retrying");
      expect(competing.data.uploads).toEqual([]);
      const persisted = await getInventoryStatus(configPath, channel.id);
      expect(persisted.state.status).toBe("waiting");
      expect(persisted.task).toMatchObject({
        status: "retrying",
        error: { kind: "busy", retryable: true },
      });
      releaseChannel?.();
      await first;
    });
  });

  it("网络中断后从检查点继续且不重复导入", async () => {
    await withInventoryFixture(async ({ configPath, store, provider }) => {
      const defaultScope = {
        channel: true,
        uploads: true,
        videos: true,
      };
      provider.failOnPageToken = "page-2";
      const interrupted = await syncInventory(
        configPath,
        { channelId: channel.id, scope: defaultScope },
        { provider, credentialStore: store },
      );
      expect(interrupted.state.status).toBe("partial");
      expect(interrupted.state.checkpoint.uploadPageToken).toBe("page-2");
      expect(interrupted.data.uploads).toHaveLength(1);

      provider.failOnPageToken = undefined;
      const resumed = await syncInventory(
        configPath,
        { channelId: channel.id, scope: defaultScope },
        { provider, credentialStore: store },
      );
      expect(resumed.state.status).toBe("completed");
      expect(resumed.data.uploads).toHaveLength(2);
      expect(resumed.data.videos).toHaveLength(2);
      expect(provider.uploadCalls).toEqual(["first", "page-2", "page-2"]);
    });
  });

  it("进程崩溃遗留 running 状态时从已确认检查点恢复", async () => {
    await withInventoryFixture(
      async ({ configPath, root, store, provider, connectionId }) => {
        const defaultScope = {
          channel: true,
          uploads: true,
          videos: true,
        };
        provider.failOnPageToken = "page-2";
        await syncInventory(
          configPath,
          { channelId: channel.id, scope: defaultScope },
          { provider, credentialStore: store },
        );
        const statePath = join(
          root,
          ".ytops-data",
          "inventory",
          channel.id,
          "connections",
          encodeURIComponent(connectionId),
          "tasks",
          "youtube-data-api",
          "channel+uploads+videos",
          "sync-state.json",
        );
        const crashedState = JSON.parse(await readFile(statePath, "utf8")) as {
          status: string;
          error?: unknown;
        };
        crashedState.status = "waiting";
        delete crashedState.error;
        await writeFile(
          statePath,
          `${JSON.stringify(crashedState, null, 2)}\n`,
          "utf8",
        );

        provider.failOnPageToken = undefined;
        provider.uploadCalls = [];
        const resumed = await syncInventory(
          configPath,
          { channelId: channel.id, scope: defaultScope },
          { provider, credentialStore: store },
        );

        expect(resumed.state.status).toBe("completed");
        expect(provider.uploadCalls).toEqual(["page-2"]);
        expect(resumed.data.uploads).toHaveLength(2);
      },
    );
  });

  it("完整快照成功后移除源站已删除的 uploads 和 videos", async () => {
    await withInventoryFixture(async ({ configPath, store, provider }) => {
      const initial = await syncInventory(
        configPath,
        { channelId: channel.id },
        { provider, credentialStore: store },
      );
      expect(initial.data.uploads).toHaveLength(2);
      expect(initial.data.videos).toHaveLength(2);

      const refreshed = await syncInventory(
        configPath,
        { channelId: channel.id },
        {
          provider: new SingleItemInventoryProvider(),
          credentialStore: store,
        },
      );

      expect(refreshed.state.status).toBe("completed");
      expect(refreshed.data.uploads.map((item) => item.playlistItemId)).toEqual(
        ["PLITEM001"],
      );
      expect(refreshed.data.videos.map((item) => item.id)).toEqual([
        "VIDEO000001",
      ]);
    });
  });

  it("快照分页中断时不删除尚未完成遍历的旧资源", async () => {
    await withInventoryFixture(async ({ configPath, store, provider }) => {
      await syncInventory(
        configPath,
        { channelId: channel.id },
        { provider, credentialStore: store },
      );
      provider.failOnPageToken = "page-2";

      const partial = await syncInventory(
        configPath,
        { channelId: channel.id },
        { provider, credentialStore: store },
      );

      expect(partial.state.status).toBe("partial");
      expect(partial.data.uploads.map((item) => item.playlistItemId)).toEqual([
        "PLITEM001",
        "PLITEM002",
      ]);
      expect(partial.data.videos.map((item) => item.id)).toEqual([
        "VIDEO000001",
        "VIDEO000002",
      ]);
    });
  });

  it("partial 任务使用伪时钟公开稳定的 nextRetryAt", async () => {
    await withInventoryFixture(async ({ configPath, store, provider }) => {
      const result = await syncInventory(
        configPath,
        { channelId: channel.id, maxWorkUnits: 1 },
        {
          provider,
          credentialStore: store,
          now: () => new Date("2026-08-27T00:00:00.000Z"),
        },
      );

      expect(result.task.status).toBe("partial");
      expect(result.task.nextRetryAt).toBe("2026-08-27T00:05:00.000Z");
    });
  });

  it("重复使用单工作单元预算时从已确认 phase 继续推进", async () => {
    await withInventoryFixture(async ({ configPath, store, provider }) => {
      const first = await syncInventory(
        configPath,
        { channelId: channel.id, maxWorkUnits: 1 },
        { provider, credentialStore: store },
      );
      expect(first.state).toMatchObject({
        status: "partial",
        phase: "uploads",
      });
      expect(first.data.uploads).toEqual([]);

      const resumed = await syncInventory(
        configPath,
        { channelId: channel.id, maxWorkUnits: 1 },
        { provider, credentialStore: store },
      );

      expect(resumed.state).toMatchObject({
        status: "partial",
        phase: "uploads",
        checkpoint: { uploadPageToken: "page-2" },
        progress: { pages: 1, items: 2, videoItems: 0 },
      });
      expect(resumed.data.uploads.map((item) => item.playlistItemId)).toEqual([
        "PLITEM001",
      ]);
    });
  });

  it("最后一个上传页恰好耗尽预算时仍完成上传范围", async () => {
    await withInventoryFixture(async ({ configPath, store, provider }) => {
      const uploadsScope = {
        channel: true,
        uploads: true,
        videos: false,
      };
      const first = await syncInventory(
        configPath,
        { channelId: channel.id, scope: uploadsScope, maxWorkUnits: 2 },
        { provider, credentialStore: store },
      );
      expect(first.state).toMatchObject({
        status: "partial",
        phase: "uploads",
        checkpoint: { uploadPageToken: "page-2" },
      });

      const completed = await syncInventory(
        configPath,
        { channelId: channel.id, scope: uploadsScope, maxWorkUnits: 1 },
        { provider, credentialStore: store },
      );

      expect(completed.state).toMatchObject({
        status: "completed",
        phase: "complete",
        checkpoint: {
          uploadPageToken: undefined,
          uploadsComplete: true,
        },
      });
      expect(completed.data.uploads).toHaveLength(2);
    });
  });

  it("retrying 任务使用伪时钟公开稳定的 nextRetryAt", async () => {
    await withInventoryFixture(async ({ configPath, store }) => {
      const result = await syncInventory(
        configPath,
        { channelId: channel.id },
        {
          provider: new RetryableInventoryProvider(),
          credentialStore: store,
          now: () => new Date("2026-08-27T01:00:00.000Z"),
        },
      );

      expect(result.task.status).toBe("retrying");
      expect(result.task.nextRetryAt).toBe("2026-08-27T01:05:00.000Z");
    });
  });

  it("可按本次范围只同步频道元数据", async () => {
    await withInventoryFixture(async ({ configPath, store, provider }) => {
      const result = await syncInventory(
        configPath,
        {
          channelId: channel.id,
          scope: { channel: true, uploads: false, videos: false },
        },
        { provider, credentialStore: store },
      );
      expect(result.state.status).toBe("completed");
      expect(result.data.channel?.title).toBe("主频道");
      expect(result.data.uploads).toEqual([]);
      expect(result.data.videos).toEqual([]);
    });
  });
});
