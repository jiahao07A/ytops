import { mkdir, mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initializeChannelOperationsConfig } from "../src/lib/config.js";
import { MemoryCredentialStore } from "../src/lib/oauth.js";
import { syncComments, type CommentsProvider } from "../src/lib/comments.js";

const channelId = "UC1111111111111111111111";

async function fixture(
  run: (configPath: string, store: MemoryCredentialStore) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "ytops-comments-"));
  const configPath = join(root, "config.json");
  const statePath = join(root, ".ytops-data", "oauth", "connections.json");
  const store = new MemoryCredentialStore();
  await initializeChannelOperationsConfig(configPath, false);
  await store.set("credential-ref", {
    accessToken: "access-token",
    refreshToken: "refresh-token",
  });
  await mkdir(join(root, ".ytops-data", "oauth"), { recursive: true });
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
    await run(configPath, store);
  } finally {
    await unlink(statePath).catch(() => undefined);
    await rmdir(join(root, ".ytops-data", "oauth")).catch(() => undefined);
    await rmdir(join(root, ".ytops-data")).catch(() => undefined);
    await unlink(configPath).catch(() => undefined);
    await rmdir(root).catch(() => undefined);
  }
}

describe("只读评论同步", () => {
  it("分页恢复、去重，并标记不可读取的深层回复", async () => {
    await fixture(async (configPath, store) => {
      const requests: Array<string | undefined> = [];
      let page = 0;
      const provider: CommentsProvider = {
        async listComments(input) {
          requests.push(input.pageToken);
          page += 1;
          if (page === 1) {
            return {
              items: [
                {
                  id: "comment-1",
                  text: "hello",
                  repliesAvailable: false,
                  replyCount: 2,
                },
              ],
              nextPageToken: "next",
              raw: { page: 1 },
            };
          }
          return {
            items: [
              {
                id: "comment-1",
                text: "hello",
                repliesAvailable: false,
                replyCount: 2,
              },
              { id: "comment-2", text: "world", repliesAvailable: true },
            ],
            raw: { page: 2 },
          };
        },
      };
      const partial = await syncComments(
        configPath,
        { channelId, maxWorkUnits: 1 },
        { provider, credentialStore: store },
      );
      expect(partial.state.status).toBe("partial");
      const complete = await syncComments(
        configPath,
        { channelId },
        { provider, credentialStore: store },
      );
      expect(complete.state.status).toBe("completed");
      expect(complete.data.comments).toHaveLength(2);
      expect(complete.data.comments[0].repliesAvailable).toBe(false);
      expect(requests).toEqual([undefined, "next"]);
    });
  });

  it("全部评论回复均可读取时，将覆盖状态聚合为 complete", async () => {
    await fixture(async (configPath, store) => {
      const provider: CommentsProvider = {
        async listComments() {
          return {
            items: [
              {
                id: "comment-1",
                text: "hello",
                repliesAvailable: true,
                replyCount: 1,
              },
              {
                id: "comment-2",
                text: "world",
                repliesAvailable: true,
                replyCount: 0,
              },
            ],
            raw: { items: 2 },
          };
        },
      };

      const result = await syncComments(
        configPath,
        { channelId },
        { provider, credentialStore: store },
      );

      expect(result.state.status).toBe("completed");
      expect(result.state.coverage).toBe("complete");
    });
  });
});
