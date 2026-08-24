import {
  mkdir,
  mkdtemp,
  readFile,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  YOUTUBE_ANALYTICS_READONLY_SCOPE,
  YOUTUBE_FORCE_SSL_SCOPE,
  YOUTUBE_READONLY_SCOPE,
  type ChannelSummary,
  type OAuthProvider,
  type OAuthToken,
  GoogleOAuthProvider,
  MemoryCredentialStore,
  beginChannelOAuth,
  completeChannelOAuth,
  getDefaultOAuthCredentialPath,
  getChannelConnectionStatus,
  selectChannelConnection,
  WindowsDpapiCredentialStore,
} from "../src/lib/oauth.js";
import { initializeChannelOperationsConfig } from "../src/lib/config.js";
import { OAuthServiceError } from "../src/lib/errors.js";

const testWindowsDpapi = process.platform === "win32" ? it : it.skip;

const channels: ChannelSummary[] = [
  { id: "UC1111111111111111111111", title: "主频道" },
  { id: "UC2222222222222222222222", title: "备用频道" },
];

class FakeOAuthProvider implements OAuthProvider {
  exchangeCount = 0;
  validationError?: Error;

  createAuthorizationUrl(input: {
    state: string;
    redirectUri: string;
    clientId: string;
    scopes: readonly string[];
  }): string {
    const query = new URLSearchParams({
      state: input.state,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      scope: input.scopes.join(" "),
    });
    return `https://example.test/oauth?${query.toString()}`;
  }

  async exchangeCode(input: {
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string;
  }): Promise<OAuthToken> {
    this.exchangeCount += 1;
    expect(input.code).toBe("authorization-code");
    expect(input.clientSecret).toBe("client-secret");
    return {
      accessToken: "access-token-must-not-leak",
      refreshToken: "refresh-token-must-not-leak",
      expiresAt: "2030-01-01T00:00:00.000Z",
    };
  }

  async listChannels(input: {
    accessToken: string;
  }): Promise<ChannelSummary[]> {
    if (this.validationError !== undefined) {
      throw this.validationError;
    }
    expect(input.accessToken).toBe("access-token-must-not-leak");
    return channels;
  }
}

async function withOAuthFixture(
  run: (fixture: {
    configPath: string;
    statePath: string;
    store: MemoryCredentialStore;
    provider: FakeOAuthProvider;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ytops-oauth-"));
  const configPath = join(root, "config.json");
  const statePath = join(root, ".ytops-data", "oauth", "connections.json");
  const store = new MemoryCredentialStore();
  const provider = new FakeOAuthProvider();

  try {
    await initializeChannelOperationsConfig(configPath, false);
    await run({ configPath, statePath, store, provider });
  } finally {
    await unlink(statePath).catch(() => undefined);
    await rmdir(join(root, ".ytops-data", "oauth")).catch(() => undefined);
    await rmdir(join(root, ".ytops-data")).catch(() => undefined);
    await unlink(configPath).catch(() => undefined);
    await rmdir(root).catch(() => undefined);
  }
}

describe("频道 OAuth 接入", () => {
  it("默认 DPAPI 凭据路径固定在用户目录，不跟随项目数据目录", () => {
    expect(getDefaultOAuthCredentialPath()).toContain(".ytops");
    expect(getDefaultOAuthCredentialPath()).toContain("credentials.dpapi.json");
    expect(getDefaultOAuthCredentialPath()).not.toContain(".ytops-data");
  });

  it("分页读取全部可访问频道，并把 pageToken 传给下一页", async () => {
    const requests: string[] = [];
    const responses = [
      new Response(
        JSON.stringify({
          items: [
            { id: channels[0].id, snippet: { title: channels[0].title } },
          ],
          nextPageToken: "next-page",
        }),
        { status: 200 },
      ),
      new Response(
        JSON.stringify({
          items: [
            { id: channels[1].id, snippet: { title: channels[1].title } },
          ],
        }),
        { status: 200 },
      ),
    ];
    const provider = new GoogleOAuthProvider(async (input) => {
      requests.push(String(input));
      return responses.shift() as Response;
    });

    await expect(
      provider.listChannels({ accessToken: "access-token" }),
    ).resolves.toEqual(channels);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("pageToken=next-page");
  });

  it("启动授权时生成带 state 的 URL，且只申请频道只读范围", async () => {
    await withOAuthFixture(async ({ configPath, store, provider }) => {
      const result = await beginChannelOAuth(
        configPath,
        {
          clientId: "client-id",
          redirectUri: "http://127.0.0.1:8765/oauth2callback",
        },
        {
          provider,
          credentialStore: store,
          stateFactory: () => "state-token-long-enough",
        },
      );

      expect(result.selectionRequired).toBe(true);
      expect(result.state).toBe("state-token-long-enough");
      expect(result.scopes).toEqual([YOUTUBE_READONLY_SCOPE]);
      expect(result.authorizationUrl).toContain("client-id");
      expect(result.authorizationUrl).toContain(
        encodeURIComponent(YOUTUBE_READONLY_SCOPE),
      );
    });
  });

  it("允许 Analytics 只读范围，但拒绝任何未列入白名单的写入范围", async () => {
    await withOAuthFixture(async ({ configPath, store, provider }) => {
      await expect(
        beginChannelOAuth(
          configPath,
          {
            clientId: "client-id",
            redirectUri: "http://127.0.0.1:8765/oauth2callback",
            scopes: [YOUTUBE_READONLY_SCOPE, YOUTUBE_ANALYTICS_READONLY_SCOPE],
          },
          {
            provider,
            credentialStore: store,
            stateFactory: () => "state-token-long-enough",
          },
        ),
      ).resolves.toMatchObject({
        scopes: [YOUTUBE_READONLY_SCOPE, YOUTUBE_ANALYTICS_READONLY_SCOPE],
      });

      await expect(
        beginChannelOAuth(
          configPath,
          {
            clientId: "client-id",
            redirectUri: "http://127.0.0.1:8765/oauth2callback",
            scopes: [
              YOUTUBE_READONLY_SCOPE,
              "https://www.googleapis.com/auth/youtube.upload",
            ],
          },
          {
            provider,
            credentialStore: store,
            stateFactory: () => "state-token-long-enough",
          },
        ),
      ).rejects.toThrow("只允许");
    });
  });

  it("允许显式启用评论读取所需的官方 scope", async () => {
    await withOAuthFixture(async ({ configPath, store, provider }) => {
      await expect(
        beginChannelOAuth(
          configPath,
          {
            clientId: "client-id",
            redirectUri: "http://127.0.0.1:8765/oauth2callback",
            scopes: [YOUTUBE_READONLY_SCOPE, YOUTUBE_FORCE_SSL_SCOPE],
            capabilities: { comments: true },
          },
          {
            provider,
            credentialStore: store,
            stateFactory: () => "state-token-long-enough",
          },
        ),
      ).resolves.toMatchObject({
        scopes: [YOUTUBE_READONLY_SCOPE, YOUTUBE_FORCE_SSL_SCOPE],
      });
    });
  });

  it("拒绝未声明评论能力时直接附加 force-ssl scope", async () => {
    await withOAuthFixture(async ({ configPath, store, provider }) => {
      await expect(
        beginChannelOAuth(
          configPath,
          {
            clientId: "client-id",
            redirectUri: "http://127.0.0.1:8765/oauth2callback",
            scopes: [YOUTUBE_READONLY_SCOPE, YOUTUBE_FORCE_SSL_SCOPE],
          },
          {
            provider,
            credentialStore: store,
            stateFactory: () => "state-token-long-enough",
          },
        ),
      ).rejects.toThrow("只允许");
    });
  });

  it("完成授权后展示全部频道，必须显式选择目标频道", async () => {
    await withOAuthFixture(
      async ({ configPath, statePath, store, provider }) => {
        const dependencies = {
          provider,
          credentialStore: store,
          stateFactory: () => "state-token-long-enough",
        };
        await beginChannelOAuth(
          configPath,
          {
            clientId: "client-id",
            redirectUri: "http://127.0.0.1:8765/oauth2callback",
          },
          dependencies,
        );

        const completed = await completeChannelOAuth(
          configPath,
          {
            code: "authorization-code",
            state: "state-token-long-enough",
            clientSecret: "client-secret",
          },
          dependencies,
        );

        expect(completed.selectionRequired).toBe(true);
        expect(completed.status).toBe("selection-required");
        expect(completed.availableChannels).toEqual(channels);
        expect(completed.selectedChannelId).toBeUndefined();

        const statusBeforeSelection = await getChannelConnectionStatus(
          configPath,
          {
            credentialStore: store,
          },
        );
        expect(statusBeforeSelection.status).toBe("selection-required");
        expect(statusBeforeSelection.selectedChannelId).toBeUndefined();
        expect(statusBeforeSelection.availableChannels).toEqual(channels);

        const selected = await selectChannelConnection(
          configPath,
          channels[1].id,
          {
            credentialStore: store,
          },
        );
        expect(selected.status).toBe("connected");
        expect(selected.selectionRequired).toBe(false);
        expect(selected.selectedChannelId).toBe(channels[1].id);
        expect(selected.connections).toEqual([
          expect.objectContaining({
            channelId: channels[1].id,
            title: channels[1].title,
            status: "connected",
          }),
        ]);
        expect(provider.exchangeCount).toBe(1);
        expect(await store.getSecret("google-oauth-client-secret")).toBe(
          "client-secret",
        );

        const storedStatus = await getChannelConnectionStatus(configPath, {
          credentialStore: store,
        });
        expect(storedStatus.status).toBe("connected");

        const unavailableStatus = await getChannelConnectionStatus(configPath, {
          credentialStore: new MemoryCredentialStore(),
        });
        expect(unavailableStatus).toMatchObject({
          status: "unavailable",
          reason: expect.stringContaining("受保护 OAuth 凭据"),
          connections: [
            {
              channelId: channels[1].id,
              status: "unavailable",
              reason: expect.stringContaining("受保护 OAuth 凭据"),
            },
          ],
        });

        provider.validationError = new OAuthServiceError(
          "OAuth 凭据已被撤销或失效，请重新完成授权。",
        );
        const revokedStatus = await getChannelConnectionStatus(configPath, {
          credentialStore: store,
          provider,
        });
        expect(revokedStatus).toMatchObject({
          status: "unavailable",
          reason: expect.stringContaining("撤销"),
        });

        const stateFile = await readFile(statePath, "utf8");
        expect(stateFile).not.toContain("access-token-must-not-leak");
        expect(stateFile).not.toContain("refresh-token-must-not-leak");
        expect(JSON.stringify(selected)).not.toContain("token-must-not-leak");
      },
    );
  });

  it("拒绝错误 state，并且不会交换或保存授权令牌", async () => {
    await withOAuthFixture(async ({ configPath, store, provider }) => {
      const dependencies = {
        provider,
        credentialStore: store,
        stateFactory: () => "state-token-long-enough",
      };
      await beginChannelOAuth(
        configPath,
        {
          clientId: "client-id",
          redirectUri: "http://127.0.0.1:8765/oauth2callback",
        },
        dependencies,
      );

      await expect(
        completeChannelOAuth(
          configPath,
          {
            code: "authorization-code",
            state: "wrong-state",
            clientSecret: "client-secret",
          },
          dependencies,
        ),
      ).rejects.toThrow("state");
      expect(provider.exchangeCount).toBe(0);
      expect(await getChannelConnectionStatus(configPath)).toMatchObject({
        availableChannels: [],
        connections: [],
      });
    });
  });

  it("授权完成可以读取受保护存储中的客户端秘密", async () => {
    await withOAuthFixture(async ({ configPath, store, provider }) => {
      const dependencies = {
        provider,
        credentialStore: store,
        stateFactory: () => "state-token-long-enough",
      };
      await store.setSecret("google-oauth-client-secret", "client-secret");
      await beginChannelOAuth(
        configPath,
        {
          clientId: "client-id",
          redirectUri: "http://127.0.0.1:8765/oauth2callback",
        },
        dependencies,
      );

      await expect(
        completeChannelOAuth(
          configPath,
          {
            code: "authorization-code",
            state: "state-token-long-enough",
          },
          dependencies,
        ),
      ).resolves.toMatchObject({ status: "selection-required" });
      expect(provider.exchangeCount).toBe(1);
    });
  });

  it("拒绝格式错误或过期的 OAuth state", async () => {
    await withOAuthFixture(
      async ({ configPath, statePath, store, provider }) => {
        await beginChannelOAuth(
          configPath,
          {
            clientId: "client-id",
            redirectUri: "http://127.0.0.1:8765/oauth2callback",
          },
          {
            provider,
            credentialStore: store,
            stateFactory: () => "state-token-long-enough",
          },
        );
        const state = JSON.parse(await readFile(statePath, "utf8")) as {
          pendingAuth: { createdAt: string };
        };
        state.pendingAuth.createdAt = "not-a-date";
        await writeFile(statePath, `${JSON.stringify(state)}\n`, "utf8");

        await expect(
          completeChannelOAuth(
            configPath,
            {
              code: "authorization-code",
              state: "state-token-long-enough",
              clientSecret: "client-secret",
            },
            { provider, credentialStore: store },
          ),
        ).rejects.toThrow("state");
        expect(provider.exchangeCount).toBe(0);
      },
    );
  });

  it("查询状态时区分已过期的访问令牌", async () => {
    await withOAuthFixture(
      async ({ configPath, statePath, store, provider }) => {
        const dependencies = {
          provider,
          credentialStore: store,
          stateFactory: () => "state-token-long-enough",
          now: () => new Date("2026-08-19T00:00:00.000Z"),
        };
        await beginChannelOAuth(
          configPath,
          {
            clientId: "client-id",
            redirectUri: "http://127.0.0.1:8765/oauth2callback",
          },
          dependencies,
        );
        await completeChannelOAuth(
          configPath,
          {
            code: "authorization-code",
            state: "state-token-long-enough",
            clientSecret: "client-secret",
          },
          dependencies,
        );
        const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
          selectionCredentialRef: string;
        };
        await store.set(persisted.selectionCredentialRef, {
          accessToken: "expired-access-token",
          refreshToken: "refresh-token",
          expiresAt: "2026-08-18T23:59:59.000Z",
        });

        const status = await getChannelConnectionStatus(configPath, {
          credentialStore: store,
          now: () => new Date("2026-08-19T00:00:00.000Z"),
        });
        expect(status).toMatchObject({
          status: "unavailable",
          reason: expect.stringContaining("访问令牌已过期"),
        });
      },
    );
  });

  it("拒绝篡改或未知字段的 OAuth 状态文件", async () => {
    await withOAuthFixture(async ({ configPath, statePath }) => {
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(
        statePath,
        `${JSON.stringify({
          version: 1,
          availableChannels: [],
          connections: [],
          unexpectedToken: "must-not-be-accepted",
        })}\n`,
        "utf8",
      );

      await expect(getChannelConnectionStatus(configPath)).rejects.toThrow(
        "状态文件格式无效",
      );
    });
  });

  testWindowsDpapi(
    "Windows DPAPI 凭据文件不保存可读令牌或客户端秘密",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "ytops-dpapi-"));
      const credentialPath = join(root, "oauth", "credentials.dpapi.json");
      const store = new WindowsDpapiCredentialStore(credentialPath);
      try {
        await store.set("credential-ref", {
          accessToken: "access-token-must-not-leak",
          refreshToken: "refresh-token-must-not-leak",
        });
        await store.setSecret(
          "google-oauth-client-secret",
          "client-secret-must-not-leak",
        );
        const raw = await readFile(credentialPath, "utf8");
        expect(raw).not.toContain("access-token-must-not-leak");
        expect(raw).not.toContain("refresh-token-must-not-leak");
        expect(raw).not.toContain("client-secret-must-not-leak");
        await expect(store.get("credential-ref")).resolves.toMatchObject({
          accessToken: "access-token-must-not-leak",
          refreshToken: "refresh-token-must-not-leak",
        });
        await expect(
          store.getSecret("google-oauth-client-secret"),
        ).resolves.toBe("client-secret-must-not-leak");
      } finally {
        await unlink(credentialPath).catch(() => undefined);
        await rmdir(join(root, "oauth")).catch(() => undefined);
        await rmdir(root).catch(() => undefined);
      }
    },
  );
});
