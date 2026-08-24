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
  selectChannelConnection,
  type ChannelSummary,
  type OAuthProvider,
  type OAuthToken,
} from "../src/lib/oauth.js";
import {
  getInventoryStatus,
  syncInventory,
  type InventoryProvider,
  type InventoryVideo,
  type InventoryUploadItem,
} from "../src/lib/inventory.js";
import { initializeChannelOperationsConfig } from "../src/lib/config.js";

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
    await selectChannelConnection(configPath, channel.id, {
      credentialStore: store,
    });
    await run({ configPath, root, store, provider });
  } finally {
    await removeTree(join(root, ".ytops-data"));
    await unlink(configPath).catch(() => undefined);
    await rmdir(root).catch(() => undefined);
  }
}

describe("可恢复基础数据同步", () => {
  it("保存频道、上传清单、视频、原始证据和完成状态", async () => {
    await withInventoryFixture(
      async ({ configPath, root, store, provider }) => {
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

  it("网络中断后从检查点继续且不重复导入", async () => {
    await withInventoryFixture(async ({ configPath, store, provider }) => {
      provider.failOnPageToken = "page-2";
      const interrupted = await syncInventory(
        configPath,
        { channelId: channel.id },
        { provider, credentialStore: store },
      );
      expect(interrupted.state.status).toBe("partial");
      expect(interrupted.state.checkpoint.uploadPageToken).toBe("page-2");
      expect(interrupted.data.uploads).toHaveLength(1);

      provider.failOnPageToken = undefined;
      const resumed = await syncInventory(
        configPath,
        { channelId: channel.id },
        { provider, credentialStore: store },
      );
      expect(resumed.state.status).toBe("completed");
      expect(resumed.data.uploads).toHaveLength(2);
      expect(resumed.data.videos).toHaveLength(2);
      expect(provider.uploadCalls).toEqual(["first", "page-2", "page-2"]);
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
