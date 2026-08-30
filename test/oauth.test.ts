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
import { describe, expect, it, vi } from "vitest";
import {
  YOUTUBE_ANALYTICS_READONLY_SCOPE,
  YOUTUBE_FORCE_SSL_SCOPE,
  YOUTUBE_READONLY_SCOPE,
  type ChannelSummary,
  type CredentialStore,
  type OAuthProvider,
  type OAuthRefreshResult,
  type OAuthTokenRefreshProvider,
  type OAuthToken,
  OAuthTokenRefreshError,
  GoogleOAuthProvider,
  MemoryCredentialStore,
  YOUTUBE_ANALYTICS_MONETARY_READONLY_SCOPE,
  beginChannelOAuth,
  completeChannelOAuth,
  getDefaultOAuthCredentialPath,
  getChannelAccessToken,
  getChannelConnectionStatus,
  selectChannelConnection,
  WindowsDpapiCredentialStore,
} from "../src/lib/oauth.js";
import {
  initializeChannelOperationsConfig,
  updateGlobalChannelOperationsConfig,
} from "../src/lib/config.js";
import { OAuthServiceError } from "../src/lib/errors.js";

const testWindowsDpapi = process.platform === "win32" ? it : it.skip;

const channels: ChannelSummary[] = [
  { id: "UC1111111111111111111111", title: "主频道" },
  { id: "UC2222222222222222222222", title: "备用频道" },
];

class FakeOAuthProvider implements OAuthProvider, OAuthTokenRefreshProvider {
  exchangeCount = 0;
  refreshCount = 0;
  expectedClientSecret = "client-secret";
  validationError?: Error;
  refreshGate?: Promise<void>;
  refreshError?: unknown;
  refreshResult: OAuthRefreshResult = {
    accessToken: "refreshed-access-token-must-not-leak",
    expiresAt: "2030-01-01T00:00:00.000Z",
  };

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
    expect(input.clientSecret).toBe(this.expectedClientSecret);
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

  async refreshAccessToken(input: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }): Promise<OAuthRefreshResult> {
    this.refreshCount += 1;
    expect(input).toEqual({
      clientId: "client-id",
      clientSecret: this.expectedClientSecret,
      refreshToken: "refresh-token-must-not-leak",
    });
    await this.refreshGate;
    if (this.refreshError !== undefined) {
      throw this.refreshError;
    }
    return this.refreshResult;
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

  it("使用官方 OAuth 客户端刷新并读取 tokens 事件", async () => {
    let configuredRefreshToken: string | null | undefined;
    let tokensListener:
      | ((tokens: {
          access_token?: string | null;
          refresh_token?: string | null;
          expiry_date?: number | null;
          token_type?: string | null;
          scope?: string;
        }) => void)
      | undefined;
    const refreshClient = {
      credentials: {},
      on(
        event: string,
        listener: (tokens: {
          access_token?: string | null;
          refresh_token?: string | null;
          expiry_date?: number | null;
          token_type?: string | null;
          scope?: string;
        }) => void,
      ) {
        expect(event).toBe("tokens");
        tokensListener = listener;
        return this;
      },
      setCredentials(credentials: { refresh_token?: string | null }) {
        configuredRefreshToken = credentials.refresh_token;
      },
      async getAccessToken() {
        tokensListener?.({
          access_token: "official-refreshed-access-token",
          refresh_token: "official-rotated-refresh-token",
          expiry_date: Date.parse("2030-02-01T00:00:00.000Z"),
          token_type: "Bearer",
          scope: YOUTUBE_READONLY_SCOPE,
        });
        return {
          token: "official-refreshed-access-token",
          expiryDate: Date.parse("2030-02-01T00:00:00.000Z"),
        };
      },
    };
    const provider = new GoogleOAuthProvider(
      globalThis.fetch.bind(globalThis),
      () => refreshClient,
    );

    await expect(
      provider.refreshAccessToken({
        clientId: "client-id",
        clientSecret: "client-secret-must-not-leak",
        refreshToken: "refresh-token-must-not-leak",
      }),
    ).resolves.toEqual({
      accessToken: "official-refreshed-access-token",
      refreshToken: "official-rotated-refresh-token",
      expiresAt: "2030-02-01T00:00:00.000Z",
      tokenType: "Bearer",
      scope: YOUTUBE_READONLY_SCOPE,
    });
    expect(configuredRefreshToken).toBe("refresh-token-must-not-leak");
  });

  it("官方刷新响应的过期时间超出 Date 范围时返回脱敏错误", async () => {
    let tokensListener:
      | ((tokens: {
          access_token?: string | null;
          expiry_date?: number | null;
        }) => void)
      | undefined;
    const refreshClient = {
      credentials: {},
      on(
        _event: string,
        listener: (tokens: {
          access_token?: string | null;
          expiry_date?: number | null;
        }) => void,
      ) {
        tokensListener = listener;
        return this;
      },
      setCredentials() {},
      async getAccessToken() {
        tokensListener?.({
          access_token: "access-token-must-not-leak",
          expiry_date: Number.MAX_VALUE,
        });
        return { token: "access-token-must-not-leak", expiryDate: null };
      },
    };
    const provider = new GoogleOAuthProvider(
      globalThis.fetch.bind(globalThis),
      () => refreshClient,
    );

    const failure = await provider
      .refreshAccessToken({
        clientId: "client-id",
        clientSecret: "client-secret-must-not-leak",
        refreshToken: "refresh-token-must-not-leak",
      })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "OAUTH_SERVICE",
      kind: "invalid-response",
      retryable: true,
    });
    expect(String((failure as Error).message)).not.toContain("must-not-leak");
  });

  it.each([
    {
      upstreamError: {
        response: {
          status: 400,
          data: { error: "invalid_grant" },
        },
        message: "must-not-leak refresh-token-must-not-leak",
      },
      expectedKind: "invalid-grant",
      expectedRetryable: false,
    },
    {
      upstreamError: {
        response: {
          status: 401,
          data: { error: "unauthorized" },
        },
        message: "must-not-leak client-secret-must-not-leak",
      },
      expectedKind: "revoked",
      expectedRetryable: false,
    },
    {
      upstreamError: {
        code: "ECONNRESET",
        message: "must-not-leak refresh-token-must-not-leak",
      },
      expectedKind: "network",
      expectedRetryable: true,
    },
    {
      upstreamError: {
        response: {
          status: 400,
          data: { error: "invalid_client" },
        },
        message: "must-not-leak client-secret-must-not-leak",
      },
      expectedKind: "invalid-response",
      expectedRetryable: false,
    },
    {
      upstreamError: {
        response: {
          status: 429,
          data: { error: "rate_limited" },
        },
        message: "must-not-leak refresh-token-must-not-leak",
      },
      expectedKind: "network",
      expectedRetryable: true,
    },
  ] as const)(
    "把 Google 刷新失败映射为安全且可操作的 $expectedKind 状态",
    async ({ upstreamError, expectedKind, expectedRetryable }) => {
      const refreshClient = {
        credentials: {},
        on() {
          return this;
        },
        setCredentials() {},
        async getAccessToken() {
          throw upstreamError;
        },
      };
      const provider = new GoogleOAuthProvider(
        globalThis.fetch.bind(globalThis),
        () => refreshClient,
      );

      const failure = await provider
        .refreshAccessToken({
          clientId: "client-id",
          clientSecret: "client-secret-must-not-leak",
          refreshToken: "refresh-token-must-not-leak",
        })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(OAuthTokenRefreshError);
      expect(failure).toMatchObject({
        code: "OAUTH_SERVICE",
        kind: expectedKind,
        retryable: expectedRetryable,
      });
      expect(String((failure as Error).message)).not.toContain("must-not-leak");
    },
  );

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

  it("货币权限未 opt-in 时拒绝申请货币 scope，且绝不伪装成零值", async () => {
    await withOAuthFixture(async ({ configPath, store, provider }) => {
      await expect(
        beginChannelOAuth(
          configPath,
          {
            clientId: "client-id",
            redirectUri: "http://127.0.0.1:8765/oauth2callback",
            scopes: [
              YOUTUBE_READONLY_SCOPE,
              YOUTUBE_ANALYTICS_MONETARY_READONLY_SCOPE,
            ],
            capabilities: { analyticsRevenue: true },
          },
          {
            provider,
            credentialStore: store,
            stateFactory: () => "state-token-long-enough",
          },
        ),
      ).rejects.toThrow("货币");
    });
  });

  it("配置显式 opt-in 后允许申请货币 scope", async () => {
    await withOAuthFixture(async ({ configPath, store, provider }) => {
      await updateGlobalChannelOperationsConfig(configPath, {
        analytics: { revenueOptIn: true },
      });
      await expect(
        beginChannelOAuth(
          configPath,
          {
            clientId: "client-id",
            redirectUri: "http://127.0.0.1:8765/oauth2callback",
            scopes: [
              YOUTUBE_READONLY_SCOPE,
              YOUTUBE_ANALYTICS_MONETARY_READONLY_SCOPE,
            ],
            capabilities: { analyticsRevenue: true },
          },
          {
            provider,
            credentialStore: store,
            stateFactory: () => "state-token-long-enough",
          },
        ),
      ).resolves.toMatchObject({
        scopes: [
          YOUTUBE_READONLY_SCOPE,
          YOUTUBE_ANALYTICS_MONETARY_READONLY_SCOPE,
        ],
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

  it("过期但可续期的凭据保持可用，畸形过期时间明确不可用", async () => {
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
        await selectChannelConnection(configPath, channels[0].id, dependencies);
        const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
          connections: [{ credentialRef: string }];
        };
        const credentialRef = persisted.connections[0].credentialRef;
        await store.set(credentialRef, {
          accessToken: "expired-access-token",
          refreshToken: "refresh-token",
          clientId: "client-id",
          expiresAt: "2026-08-18T23:59:59.000Z",
        });

        const status = await getChannelConnectionStatus(configPath, {
          credentialStore: store,
          secretStore: store,
          now: () => new Date("2026-08-19T00:00:00.000Z"),
        });
        expect(status).toMatchObject({
          status: "connected",
        });
        expect(status.reason).toBeUndefined();

        await store.set(credentialRef, {
          accessToken: "malformed-expiry-access-token",
          refreshToken: "refresh-token",
          clientId: "client-id",
          expiresAt: "not-a-date",
        });
        const malformed = await getChannelConnectionStatus(configPath, {
          credentialStore: store,
          secretStore: store,
          now: () => new Date("2026-08-19T00:00:00.000Z"),
        });
        expect(malformed).toMatchObject({
          status: "unavailable",
          reason: expect.stringContaining("过期时间"),
        });

        const accessFailure = await getChannelAccessToken(
          configPath,
          undefined,
          {
            credentialStore: store,
            secretStore: store,
            tokenRefreshProvider: provider,
            now: () => new Date("2026-08-19T00:00:00.000Z"),
          },
        ).catch((error: unknown) => error);
        expect(accessFailure).toMatchObject({
          code: "OAUTH_SERVICE",
          kind: "invalid-response",
          retryable: false,
        });
      },
    );
  });

  it("访问令牌过期后自动续期并保留已有刷新令牌", async () => {
    await withOAuthFixture(
      async ({ configPath, statePath, store, provider }) => {
        const now = () => new Date("2026-08-19T00:00:00.000Z");
        const dependencies = {
          provider,
          credentialStore: store,
          secretStore: store,
          stateFactory: () => "state-token-long-enough",
          now,
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
        await selectChannelConnection(configPath, channels[0].id, dependencies);

        const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
          connections: [{ credentialRef: string }];
        };
        const credentialRef = persisted.connections[0].credentialRef;
        await store.set(credentialRef, {
          accessToken: "expired-access-token-must-not-leak",
          refreshToken: "refresh-token-must-not-leak",
          clientId: "client-id",
          expiresAt: "2026-08-18T23:59:59.000Z",
        });

        await expect(
          getChannelAccessToken(configPath, channels[0].id, {
            credentialStore: store,
            secretStore: store,
            tokenRefreshProvider: provider,
            now,
          }),
        ).resolves.toEqual({
          channelId: channels[0].id,
          accessToken: "refreshed-access-token-must-not-leak",
        });
        expect(provider.refreshCount).toBe(1);
        await expect(store.get(credentialRef)).resolves.toEqual({
          accessToken: "refreshed-access-token-must-not-leak",
          refreshToken: "refresh-token-must-not-leak",
          clientId: "client-id",
          expiresAt: "2030-01-01T00:00:00.000Z",
        });

        provider.refreshResult = {
          accessToken: "rotated-access-token-must-not-leak",
          refreshToken: "rotated-refresh-token-must-not-leak",
          expiresAt: "2031-01-01T00:00:00.000Z",
        };
        await store.set(credentialRef, {
          accessToken: "expired-again-access-token-must-not-leak",
          refreshToken: "refresh-token-must-not-leak",
          clientId: "client-id",
          expiresAt: "2026-08-18T23:59:59.000Z",
        });
        await getChannelAccessToken(configPath, channels[0].id, {
          credentialStore: store,
          secretStore: store,
          tokenRefreshProvider: provider,
          now,
        });
        await expect(store.get(credentialRef)).resolves.toMatchObject({
          accessToken: "rotated-access-token-must-not-leak",
          refreshToken: "rotated-refresh-token-must-not-leak",
        });
      },
    );
  });

  it("未过期时不刷新并持久保存重启续期所需的客户端 ID", async () => {
    await withOAuthFixture(
      async ({ configPath, statePath, store, provider }) => {
        const dependencies = {
          provider,
          credentialStore: store,
          secretStore: store,
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
        await selectChannelConnection(configPath, channels[0].id, dependencies);

        await expect(
          getChannelAccessToken(configPath, channels[0].id, {
            credentialStore: store,
            secretStore: store,
            tokenRefreshProvider: provider,
            now: dependencies.now,
          }),
        ).resolves.toEqual({
          channelId: channels[0].id,
          accessToken: "access-token-must-not-leak",
        });
        expect(provider.refreshCount).toBe(0);

        const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
          connections: [{ credentialRef: string }];
        };
        await expect(
          store.get(persisted.connections[0].credentialRef),
        ).resolves.toMatchObject({ clientId: "client-id" });
      },
    );
  });

  it("同一频道并发续期只发起一次刷新", async () => {
    await withOAuthFixture(
      async ({ configPath, statePath, store, provider }) => {
        const now = () => new Date("2026-08-19T00:00:00.000Z");
        const dependencies = {
          provider,
          credentialStore: store,
          secretStore: store,
          stateFactory: () => "state-token-long-enough",
          now,
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
        await selectChannelConnection(configPath, channels[0].id, dependencies);
        const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
          connections: [{ credentialRef: string }];
        };
        await store.set(persisted.connections[0].credentialRef, {
          accessToken: "expired-access-token-must-not-leak",
          refreshToken: "refresh-token-must-not-leak",
          clientId: "client-id",
          expiresAt: "2026-08-18T23:59:59.000Z",
        });

        let releaseRefresh: (() => void) | undefined;
        provider.refreshGate = new Promise<void>((resolve) => {
          releaseRefresh = resolve;
        });
        let credentialReads = 0;
        const countingStore: CredentialStore = {
          async get(key) {
            credentialReads += 1;
            return store.get(key);
          },
          async set(key, token) {
            return store.set(key, token);
          },
          async remove(key) {
            return store.remove(key);
          },
        };
        const accessDependencies = {
          credentialStore: countingStore,
          secretStore: store,
          tokenRefreshProvider: provider,
          now,
        };
        const first = getChannelAccessToken(
          configPath,
          channels[0].id,
          accessDependencies,
        );
        const second = getChannelAccessToken(
          configPath,
          channels[0].id,
          accessDependencies,
        );
        await vi.waitFor(() =>
          expect(credentialReads).toBeGreaterThanOrEqual(3),
        );
        expect(provider.refreshCount).toBe(1);
        releaseRefresh?.();

        await expect(Promise.all([first, second])).resolves.toEqual([
          {
            channelId: channels[0].id,
            accessToken: "refreshed-access-token-must-not-leak",
          },
          {
            channelId: channels[0].id,
            accessToken: "refreshed-access-token-must-not-leak",
          },
        ]);
        expect(provider.refreshCount).toBe(1);
      },
    );
  });

  it("刷新响应无效时保留原凭据并返回可重试状态", async () => {
    await withOAuthFixture(
      async ({ configPath, statePath, store, provider }) => {
        const now = () => new Date("2026-08-19T00:00:00.000Z");
        const dependencies = {
          provider,
          credentialStore: store,
          secretStore: store,
          stateFactory: () => "state-token-long-enough",
          now,
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
        await selectChannelConnection(configPath, channels[0].id, dependencies);
        const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
          connections: [{ credentialRef: string }];
        };
        const credentialRef = persisted.connections[0].credentialRef;
        const expiredToken: OAuthToken = {
          accessToken: "expired-access-token-must-not-leak",
          refreshToken: "refresh-token-must-not-leak",
          clientId: "client-id",
          expiresAt: "2026-08-18T23:59:59.000Z",
        };
        await store.set(credentialRef, expiredToken);
        provider.refreshResult = undefined as unknown as OAuthRefreshResult;

        const failure = await getChannelAccessToken(
          configPath,
          channels[0].id,
          {
            credentialStore: store,
            secretStore: store,
            tokenRefreshProvider: provider,
            now,
          },
        ).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(OAuthTokenRefreshError);
        expect(failure).toMatchObject({
          code: "OAUTH_SERVICE",
          kind: "invalid-response",
          retryable: true,
        });
        expect(String((failure as Error).message)).not.toContain(
          "must-not-leak",
        );
        await expect(store.get(credentialRef)).resolves.toEqual(expiredToken);

        provider.refreshResult = {
          accessToken: "must-not-be-persisted",
          expiresAt: "2030-01-01T00:00:00.000Z",
        };
        provider.refreshError = new Error(
          "network must-not-leak refresh-token-must-not-leak",
        );
        const networkFailure = await getChannelAccessToken(
          configPath,
          channels[0].id,
          {
            credentialStore: store,
            secretStore: store,
            tokenRefreshProvider: provider,
            now,
          },
        ).catch((error: unknown) => error);
        expect(networkFailure).toMatchObject({
          code: "OAUTH_SERVICE",
          kind: "network",
          retryable: true,
        });
        expect(String((networkFailure as Error).message)).not.toContain(
          "must-not-leak",
        );
        await expect(store.get(credentialRef)).resolves.toEqual(expiredToken);

        provider.refreshError = undefined;
        const missingCases = [
          {
            token: { ...expiredToken, refreshToken: "" },
            secretStore: store,
            expectedKind: "missing-refresh-token",
          },
          {
            token: { ...expiredToken, clientId: undefined },
            secretStore: store,
            expectedKind: "missing-client-id",
          },
          {
            token: expiredToken,
            secretStore: {
              async getSecret() {
                return undefined;
              },
              async setSecret() {},
            },
            expectedKind: "missing-client-secret",
          },
        ] as const;
        for (const missingCase of missingCases) {
          await store.set(credentialRef, missingCase.token);
          const missingFailure = await getChannelAccessToken(
            configPath,
            channels[0].id,
            {
              credentialStore: store,
              secretStore: missingCase.secretStore,
              tokenRefreshProvider: provider,
              now,
            },
          ).catch((error: unknown) => error);
          expect(missingFailure).toMatchObject({
            code: "OAUTH_SERVICE",
            kind: missingCase.expectedKind,
            retryable: false,
          });
          expect(String((missingFailure as Error).message)).not.toContain(
            "must-not-leak",
          );
        }

        await store.set(credentialRef, expiredToken);
        const failingStore: CredentialStore = {
          async get(key) {
            return store.get(key);
          },
          async set() {
            throw new Error(
              "disk failure must-not-leak refresh-token-must-not-leak",
            );
          },
          async remove(key) {
            return store.remove(key);
          },
        };
        const persistenceFailure = await getChannelAccessToken(
          configPath,
          channels[0].id,
          {
            credentialStore: failingStore,
            secretStore: store,
            tokenRefreshProvider: provider,
            now,
          },
        ).catch((error: unknown) => error);
        expect(persistenceFailure).toMatchObject({
          code: "OAUTH_SERVICE",
          kind: "credential-store",
          retryable: true,
        });
        expect(String((persistenceFailure as Error).message)).not.toContain(
          "must-not-leak",
        );
        expect(JSON.stringify(persistenceFailure)).not.toContain(
          "must-not-leak",
        );
        await expect(store.get(credentialRef)).resolves.toEqual(expiredToken);
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
    "重启后从 Windows DPAPI 恢复并完成令牌续期与轮换",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "ytops-dpapi-"));
      const configPath = join(root, "config.json");
      const statePath = join(root, ".ytops-data", "oauth", "connections.json");
      const credentialPath = join(root, "oauth", "credentials.dpapi.json");
      const store = new WindowsDpapiCredentialStore(credentialPath);
      const provider = new FakeOAuthProvider();
      provider.expectedClientSecret = "restart-client-secret-must-not-leak";
      provider.refreshResult = {
        accessToken: "restart-access-token-must-not-leak",
        refreshToken: "restart-refresh-token-must-not-leak",
        expiresAt: "2030-01-01T00:00:00.000Z",
      };
      try {
        await initializeChannelOperationsConfig(configPath, false);
        const dependencies = {
          provider,
          credentialStore: store,
          secretStore: store,
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
            clientSecret: provider.expectedClientSecret,
          },
          dependencies,
        );
        await selectChannelConnection(configPath, channels[0].id, dependencies);
        const state = JSON.parse(await readFile(statePath, "utf8")) as {
          connections: [{ credentialRef: string }];
        };
        const credentialRef = state.connections[0].credentialRef;
        const saved = await store.get(credentialRef);
        expect(saved).toBeDefined();
        await store.set(credentialRef, {
          ...saved!,
          accessToken: "expired-access-token-must-not-leak",
          expiresAt: "2026-08-18T23:59:59.000Z",
        });

        const reopenedStore = new WindowsDpapiCredentialStore(credentialPath);
        await expect(
          getChannelAccessToken(configPath, channels[0].id, {
            credentialStore: reopenedStore,
            secretStore: reopenedStore,
            tokenRefreshProvider: provider,
            now: dependencies.now,
          }),
        ).resolves.toEqual({
          channelId: channels[0].id,
          accessToken: "restart-access-token-must-not-leak",
        });
        await expect(reopenedStore.get(credentialRef)).resolves.toMatchObject({
          accessToken: "restart-access-token-must-not-leak",
          refreshToken: "restart-refresh-token-must-not-leak",
          clientId: "client-id",
        });
        expect(provider.refreshCount).toBe(1);

        const raw = await readFile(credentialPath, "utf8");
        expect(raw).not.toContain("restart-access-token-must-not-leak");
        expect(raw).not.toContain("restart-refresh-token-must-not-leak");
        expect(raw).not.toContain(provider.expectedClientSecret);
      } finally {
        await unlink(credentialPath).catch(() => undefined);
        await rmdir(join(root, "oauth")).catch(() => undefined);
        await unlink(statePath).catch(() => undefined);
        await rmdir(join(root, ".ytops-data", "oauth")).catch(() => undefined);
        await rmdir(join(root, ".ytops-data")).catch(() => undefined);
        await unlink(configPath).catch(() => undefined);
        await rmdir(root).catch(() => undefined);
      }
    },
    15_000,
  );

  testWindowsDpapi(
    "Windows DPAPI 多实例并发写入不会丢失其他频道凭据",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "ytops-dpapi-concurrent-"));
      const credentialPath = join(root, "oauth", "credentials.dpapi.json");
      const firstStore = new WindowsDpapiCredentialStore(credentialPath);
      const secondStore = new WindowsDpapiCredentialStore(credentialPath);
      try {
        await Promise.all([
          firstStore.set("first-channel", {
            accessToken: "first-access-token-must-not-leak",
            refreshToken: "first-refresh-token-must-not-leak",
          }),
          secondStore.set("second-channel", {
            accessToken: "second-access-token-must-not-leak",
            refreshToken: "second-refresh-token-must-not-leak",
          }),
        ]);

        const reopened = new WindowsDpapiCredentialStore(credentialPath);
        await expect(reopened.get("first-channel")).resolves.toMatchObject({
          accessToken: "first-access-token-must-not-leak",
        });
        await expect(reopened.get("second-channel")).resolves.toMatchObject({
          accessToken: "second-access-token-must-not-leak",
        });
      } finally {
        await unlink(credentialPath).catch(() => undefined);
        await rmdir(join(root, "oauth")).catch(() => undefined);
        await rmdir(root).catch(() => undefined);
      }
    },
  );
});
