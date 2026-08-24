import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { execa } from "execa";
import { z } from "zod";
import {
  containsCredentialLikeText,
  validateChannelOperationsConfig,
} from "./config.js";
import { OAuthServiceError, UserInputError } from "./errors.js";

export const YOUTUBE_READONLY_SCOPE =
  "https://www.googleapis.com/auth/youtube.readonly";
export const YOUTUBE_ANALYTICS_READONLY_SCOPE =
  "https://www.googleapis.com/auth/yt-analytics.readonly";
/**
 * YouTube's comment list endpoints use this broader API scope. The CLI still
 * exposes comments as read-only; callers must opt into the scope explicitly.
 */
export const YOUTUBE_FORCE_SSL_SCOPE =
  "https://www.googleapis.com/auth/youtube.force-ssl";

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CHANNELS_ENDPOINT = "https://www.googleapis.com/youtube/v3/channels";
const STATE_LIFETIME_MS = 10 * 60 * 1000;
const GOOGLE_CLIENT_SECRET_KEY = "google-oauth-client-secret";
const ALLOWED_OAUTH_SCOPES = new Set([
  YOUTUBE_READONLY_SCOPE,
  YOUTUBE_ANALYTICS_READONLY_SCOPE,
  YOUTUBE_FORCE_SSL_SCOPE,
]);

export interface ChannelSummary {
  id: string;
  title: string;
  description?: string;
  uploadsPlaylistId?: string;
}

export interface OAuthToken {
  accessToken: string;
  refreshToken: string;
  expiresAt?: string;
  tokenType?: string;
  scope?: string;
}

export interface OAuthProvider {
  createAuthorizationUrl(input: {
    state: string;
    redirectUri: string;
    clientId: string;
    scopes: readonly string[];
  }): string;
  exchangeCode(input: {
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string;
  }): Promise<OAuthToken>;
  listChannels(input: { accessToken: string }): Promise<ChannelSummary[]>;
}

export interface CredentialStore {
  get(key: string): Promise<OAuthToken | undefined>;
  set(key: string, token: OAuthToken): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface ProtectedSecretStore {
  getSecret(key: string): Promise<string | undefined>;
  setSecret(key: string, value: string): Promise<void>;
}

export type ChannelConnectionAvailability = "connected" | "unavailable";

export type ChannelConnectionOverallStatus =
  "not-connected" | "selection-required" | "connected" | "unavailable";

export class MemoryCredentialStore
  implements CredentialStore, ProtectedSecretStore
{
  private readonly values = new Map<string, OAuthToken>();
  private readonly secrets = new Map<string, string>();

  async get(key: string): Promise<OAuthToken | undefined> {
    const token = this.values.get(key);
    return token === undefined ? undefined : { ...token };
  }

  async set(key: string, token: OAuthToken): Promise<void> {
    this.values.set(key, { ...token });
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }

  async getSecret(key: string): Promise<string | undefined> {
    return this.secrets.get(key);
  }

  async setSecret(key: string, value: string): Promise<void> {
    this.secrets.set(key, value);
  }
}

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class GoogleOAuthProvider implements OAuthProvider {
  constructor(
    private readonly fetcher: Fetcher = globalThis.fetch.bind(globalThis),
  ) {}

  createAuthorizationUrl(input: {
    state: string;
    redirectUri: string;
    clientId: string;
    scopes: readonly string[];
  }): string {
    const url = new URL(AUTHORIZATION_ENDPOINT);
    url.search = new URLSearchParams({
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      scope: input.scopes.join(" "),
      state: input.state,
    }).toString();
    return url.toString();
  }

  async exchangeCode(input: {
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string;
  }): Promise<OAuthToken> {
    const response = await this.fetcher(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: input.code,
        client_id: input.clientId,
        client_secret: input.clientSecret,
        redirect_uri: input.redirectUri,
        grant_type: "authorization_code",
      }),
    });

    const payload = await readJson(response);
    if (!response.ok) {
      throw new OAuthServiceError(
        "Google OAuth 授权交换失败，请检查授权码和客户端配置。",
      );
    }

    const accessToken = stringProperty(payload, "access_token");
    const refreshToken = stringProperty(payload, "refresh_token");
    if (accessToken === undefined || refreshToken === undefined) {
      throw new OAuthServiceError(
        "Google OAuth 未返回可持久化的访问令牌和刷新令牌，请重新授权。",
      );
    }

    const expiresIn = numberProperty(payload, "expires_in");
    return {
      accessToken,
      refreshToken,
      ...(expiresIn === undefined
        ? {}
        : { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() }),
      ...(stringProperty(payload, "token_type") === undefined
        ? {}
        : { tokenType: stringProperty(payload, "token_type") }),
      ...(stringProperty(payload, "scope") === undefined
        ? {}
        : { scope: stringProperty(payload, "scope") }),
    };
  }

  async listChannels(input: {
    accessToken: string;
  }): Promise<ChannelSummary[]> {
    const channels: ChannelSummary[] = [];
    const seenPageTokens = new Set<string>();
    let pageToken: string | undefined;

    while (true) {
      const url = new URL(CHANNELS_ENDPOINT);
      url.search = new URLSearchParams({
        part: "snippet,contentDetails",
        mine: "true",
        maxResults: "50",
        ...(pageToken === undefined ? {} : { pageToken }),
      }).toString();
      const response = await this.fetcher(url, {
        headers: { authorization: `Bearer ${input.accessToken}` },
      });
      const payload = await readJson(response);
      if (!response.ok) {
        if (response.status === 401) {
          throw new OAuthServiceError(
            "OAuth 凭据已被撤销或失效，请重新完成授权。",
          );
        }
        if (response.status === 403) {
          throw new OAuthServiceError(
            "OAuth 凭据权限不足或已被撤销，请检查授权范围后重新授权。",
          );
        }
        throw new OAuthServiceError(
          "无法读取当前授权用户的频道列表，请检查 OAuth 权限或配额状态。",
        );
      }

      if (!isRecord(payload) || !Array.isArray(payload.items)) {
        throw new OAuthServiceError("Google API 返回的频道列表格式无效。");
      }

      channels.push(
        ...payload.items.flatMap((item) => {
          if (!isRecord(item)) {
            return [];
          }
          const id = stringProperty(item, "id");
          const snippet = isRecord(item.snippet) ? item.snippet : undefined;
          const title =
            snippet === undefined
              ? undefined
              : stringProperty(snippet, "title");
          const description =
            snippet === undefined
              ? undefined
              : stringProperty(snippet, "description");
          const contentDetails = isRecord(item.contentDetails)
            ? item.contentDetails
            : undefined;
          const relatedPlaylists =
            contentDetails !== undefined &&
            isRecord(contentDetails.relatedPlaylists)
              ? contentDetails.relatedPlaylists
              : undefined;
          const uploadsPlaylistId =
            relatedPlaylists === undefined
              ? undefined
              : stringProperty(relatedPlaylists, "uploads");
          if (id === undefined || title === undefined) {
            return [];
          }
          return [
            {
              id,
              title,
              ...(description === undefined ? {} : { description }),
              ...(uploadsPlaylistId === undefined ? {} : { uploadsPlaylistId }),
            },
          ];
        }),
      );

      const nextPageToken = stringProperty(payload, "nextPageToken");
      if (nextPageToken === undefined || seenPageTokens.has(nextPageToken)) {
        return channels;
      }
      seenPageTokens.add(nextPageToken);
      pageToken = nextPageToken;
    }
  }
}

interface PendingAuth {
  stateHash: string;
  redirectUri: string;
  clientId: string;
  createdAt: string;
  scopes?: string[];
}

interface StoredConnection {
  connectionId: string;
  channelId: string;
  title: string;
  description?: string;
  uploadsPlaylistId?: string;
  status: "connected";
  credentialRef: string;
  scopes: string[];
  connectedAt: string;
  updatedAt: string;
}

interface ConnectionStateFile {
  version: 1;
  pendingAuth?: PendingAuth;
  availableChannels: ChannelSummary[];
  selectionCredentialRef?: string;
  selectionScopes?: string[];
  selectedChannelId?: string;
  connections: StoredConnection[];
}

const channelSummarySchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    uploadsPlaylistId: z.string().min(1).optional(),
  })
  .strict();

const pendingAuthSchema = z
  .object({
    stateHash: z.string().regex(/^[a-f0-9]{64}$/),
    redirectUri: z.string().min(1),
    clientId: z.string().min(1),
    createdAt: z.string().min(1),
    scopes: z.array(z.string().min(1)).optional(),
  })
  .strict();

const storedConnectionSchema = z
  .object({
    connectionId: z.string().min(1),
    channelId: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    uploadsPlaylistId: z.string().min(1).optional(),
    status: z.literal("connected"),
    credentialRef: z.string().min(1),
    scopes: z.array(z.string().min(1)),
    connectedAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();

const connectionStateSchema = z
  .object({
    version: z.literal(1),
    pendingAuth: pendingAuthSchema.optional(),
    availableChannels: z.array(channelSummarySchema),
    selectionCredentialRef: z.string().min(1).optional(),
    selectionScopes: z.array(z.string().min(1)).optional(),
    selectedChannelId: z.string().min(1).optional(),
    connections: z.array(storedConnectionSchema),
  })
  .strict();

export interface PublicChannelConnection {
  connectionId: string;
  channelId: string;
  title: string;
  description?: string;
  status: ChannelConnectionAvailability;
  reason?: string;
  scopes: string[];
  connectedAt: string;
  updatedAt: string;
}

export interface ChannelConnectionStatus {
  status: ChannelConnectionOverallStatus;
  reason?: string;
  availableChannels: ChannelSummary[];
  selectionRequired: boolean;
  selectedChannelId?: string;
  connections: PublicChannelConnection[];
}

export interface OAuthWorkflowDependencies {
  provider?: OAuthProvider;
  credentialStore?: CredentialStore;
  secretStore?: ProtectedSecretStore;
  now?: () => Date;
  stateFactory?: () => string;
}

export interface OAuthRequestedCapabilities {
  comments?: boolean;
}

interface WorkflowPaths {
  statePath: string;
  credentialPath: string;
}

export function getDefaultOAuthCredentialPath(): string {
  return resolve(homedir(), ".ytops", "oauth", "credentials.dpapi.json");
}

function defaultState(): ConnectionStateFile {
  return { version: 1, availableChannels: [], connections: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value) || typeof value[key] !== "string") {
    return undefined;
  }
  return value[key] as string;
}

function numberProperty(value: unknown, key: string): number | undefined {
  if (!isRecord(value) || typeof value[key] !== "number") {
    return undefined;
  }
  return value[key] as number;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function stateHash(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

function statesMatch(actual: string, expectedHash: string): boolean {
  const actualHash = Buffer.from(stateHash(actual), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return (
    actualHash.length === expected.length &&
    timingSafeEqual(actualHash, expected)
  );
}

type CredentialInspection =
  { available: true } | { available: false; reason: string };

const MISSING_CREDENTIAL_REASON =
  "找不到关联的受保护 OAuth 凭据，请重新完成授权。";
const EXPIRED_CREDENTIAL_REASON = "OAuth 访问令牌已过期，请重新完成授权。";
const UNREADABLE_CREDENTIAL_REASON =
  "无法读取关联的受保护 OAuth 凭据，请重新完成授权。";

async function inspectCredential(
  store: CredentialStore,
  credentialRef: string,
  now: Date,
  provider?: OAuthProvider,
): Promise<CredentialInspection> {
  try {
    const token = await store.get(credentialRef);
    if (token === undefined) {
      return { available: false, reason: MISSING_CREDENTIAL_REASON };
    }
    if (token.expiresAt !== undefined) {
      const expiresAt = Date.parse(token.expiresAt);
      if (!Number.isNaN(expiresAt) && expiresAt <= now.getTime()) {
        return { available: false, reason: EXPIRED_CREDENTIAL_REASON };
      }
    }
    if (provider !== undefined) {
      await provider.listChannels({ accessToken: token.accessToken });
    }
    return { available: true };
  } catch (error) {
    if (error instanceof OAuthServiceError) {
      return { available: false, reason: error.message };
    }
    return { available: false, reason: UNREADABLE_CREDENTIAL_REASON };
  }
}

function toPublicConnection(
  connection: StoredConnection,
  credential: CredentialInspection,
): PublicChannelConnection {
  const { credentialRef: _credentialRef, ...publicConnection } = connection;
  if (credential.available) {
    return { ...publicConnection, status: "connected" };
  }
  return {
    ...publicConnection,
    status: "unavailable",
    reason: credential.reason,
  };
}

async function toPublicStatus(
  state: ConnectionStateFile,
  credentialStore: CredentialStore,
  now: Date,
  provider?: OAuthProvider,
): Promise<ChannelConnectionStatus> {
  const inspections = await Promise.all(
    state.connections.map((connection) =>
      inspectCredential(
        credentialStore,
        connection.credentialRef,
        now,
        provider,
      ),
    ),
  );
  const connections = state.connections.map((connection, index) =>
    toPublicConnection(connection, inspections[index]),
  );
  const pendingInspection =
    state.selectionCredentialRef === undefined
      ? undefined
      : await inspectCredential(
          credentialStore,
          state.selectionCredentialRef,
          now,
          provider,
        );
  const selectedConnectionIndex =
    state.selectedChannelId === undefined
      ? undefined
      : state.connections.findIndex(
          (connection) => connection.channelId === state.selectedChannelId,
        );

  let status: ChannelConnectionOverallStatus;
  let reason: string | undefined;
  if (selectedConnectionIndex !== undefined && selectedConnectionIndex >= 0) {
    const selectedInspection = inspections[selectedConnectionIndex];
    if (selectedInspection.available) {
      status = "connected";
    } else {
      status = "unavailable";
      reason = selectedInspection.reason;
    }
  } else if (state.selectedChannelId !== undefined) {
    status = "unavailable";
    reason = "选中的频道接入记录不存在，请重新完成频道选择。";
  } else if (pendingInspection !== undefined) {
    if (pendingInspection.available) {
      status = "selection-required";
    } else {
      status = "unavailable";
      reason = pendingInspection.reason;
    }
  } else if (state.connections.length === 0) {
    status = "not-connected";
  } else if (inspections.some((inspection) => inspection.available)) {
    status = "connected";
  } else {
    status = "unavailable";
    const firstUnavailable = inspections.find(
      (
        inspection,
      ): inspection is Extract<CredentialInspection, { available: false }> =>
        !inspection.available,
    );
    reason = firstUnavailable?.reason ?? UNREADABLE_CREDENTIAL_REASON;
  }

  return {
    status,
    ...(reason === undefined ? {} : { reason }),
    availableChannels: state.availableChannels,
    selectionRequired: state.selectionCredentialRef !== undefined,
    ...(state.selectedChannelId === undefined
      ? {}
      : { selectedChannelId: state.selectedChannelId }),
    connections,
  };
}

async function resolveWorkflowPaths(
  configPath: string,
): Promise<WorkflowPaths> {
  const validated = await validateChannelOperationsConfig(configPath);
  const dataDirectory = resolve(
    dirname(validated.configPath),
    validated.config.global.dataDirectory,
  );
  return {
    statePath: resolve(dataDirectory, "oauth", "connections.json"),
    credentialPath: getDefaultOAuthCredentialPath(),
  };
}

async function loadState(path: string): Promise<ConnectionStateFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const validated = connectionStateSchema.safeParse(parsed);
    if (!validated.success) {
      throw new OAuthServiceError(
        "频道接入状态文件格式无效，请移除后重新授权。",
      );
    }
    return validated.data;
  } catch (error) {
    if (error instanceof OAuthServiceError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultState();
    }
    throw new OAuthServiceError("无法读取频道接入状态文件。");
  }
}

async function saveState(
  path: string,
  state: ConnectionStateFile,
): Promise<void> {
  const serialized = JSON.stringify(state, null, 2);
  if (containsCredentialLikeText(serialized)) {
    throw new OAuthServiceError("频道接入状态不能包含 OAuth 凭据或令牌。");
  }
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${serialized}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

function createDefaultCredentialStore(path: string): CredentialStore {
  return new WindowsDpapiCredentialStore(path);
}

function asProtectedSecretStore(
  store: CredentialStore,
): ProtectedSecretStore | undefined {
  const candidate = store as Partial<ProtectedSecretStore>;
  return typeof candidate.getSecret === "function" &&
    typeof candidate.setSecret === "function"
    ? (store as CredentialStore & ProtectedSecretStore)
    : undefined;
}

export class WindowsDpapiCredentialStore
  implements CredentialStore, ProtectedSecretStore
{
  constructor(private readonly path: string) {}

  async get(key: string): Promise<OAuthToken | undefined> {
    const values = await this.readValues();
    const protectedValue = values[key];
    if (protectedValue === undefined) {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(
        await unprotectWithWindowsDpapi(protectedValue),
      );
      if (
        !isRecord(parsed) ||
        typeof parsed.accessToken !== "string" ||
        typeof parsed.refreshToken !== "string"
      ) {
        throw new Error("invalid token");
      }
      return parsed as unknown as OAuthToken;
    } catch {
      throw new OAuthServiceError("无法读取操作系统受保护的 OAuth 凭据。");
    }
  }

  async set(key: string, token: OAuthToken): Promise<void> {
    const values = await this.readValues();
    values[key] = await protectWithWindowsDpapi(JSON.stringify(token));
    await this.writeValues(values);
  }

  async remove(key: string): Promise<void> {
    const values = await this.readValues();
    delete values[key];
    await this.writeValues(values);
  }

  async getSecret(key: string): Promise<string | undefined> {
    const values = await this.readValues();
    const protectedValue = values[key];
    if (protectedValue === undefined) {
      return undefined;
    }
    try {
      return await unprotectWithWindowsDpapi(protectedValue);
    } catch {
      throw new OAuthServiceError("无法读取操作系统受保护的客户端秘密。");
    }
  }

  async setSecret(key: string, value: string): Promise<void> {
    const values = await this.readValues();
    values[key] = await protectWithWindowsDpapi(value);
    await this.writeValues(values);
  }

  private async writeValues(values: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(values, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.path);
  }

  private async readValues(): Promise<Record<string, string>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!isRecord(parsed)) {
        throw new Error("invalid credential store");
      }
      return Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw new OAuthServiceError("无法读取操作系统受保护的 OAuth 凭据文件。");
    }
  }
}

async function protectWithWindowsDpapi(value: string): Promise<string> {
  if (process.platform !== "win32") {
    throw new OAuthServiceError("OAuth 凭据存储需要 Windows 用户级凭据保护。");
  }
  const result = await execa(
    "pwsh.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$input | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString",
    ],
    { input: value, reject: false },
  );
  if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
    throw new OAuthServiceError("无法写入操作系统受保护的 OAuth 凭据。");
  }
  return result.stdout.trim();
}

async function unprotectWithWindowsDpapi(value: string): Promise<string> {
  if (process.platform !== "win32") {
    throw new OAuthServiceError("OAuth 凭据存储需要 Windows 用户级凭据保护。");
  }
  const result = await execa(
    "pwsh.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$input | ForEach-Object { $secure = ConvertTo-SecureString -String $_; $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) } }",
    ],
    { input: value, reject: false },
  );
  if (result.exitCode !== 0) {
    throw new OAuthServiceError("无法读取操作系统受保护的 OAuth 凭据。");
  }
  return result.stdout.trim();
}

export async function beginChannelOAuth(
  configPath: string,
  input: {
    clientId: string;
    redirectUri: string;
    scopes?: readonly string[];
    capabilities?: OAuthRequestedCapabilities;
  },
  dependencies: OAuthWorkflowDependencies = {},
): Promise<{
  authorizationUrl: string;
  state: string;
  redirectUri: string;
  scopes: string[];
  selectionRequired: true;
}> {
  if (input.clientId.trim().length === 0) {
    throw new UserInputError("未配置 Google OAuth 客户端 ID。");
  }
  if (input.redirectUri.trim().length === 0) {
    throw new UserInputError("OAuth 回调地址不能为空。");
  }
  const requestedScopes = [
    ...new Set(
      (input.scopes ?? [YOUTUBE_READONLY_SCOPE])
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0),
    ),
  ];
  if (
    requestedScopes.length === 0 ||
    !requestedScopes.includes(YOUTUBE_READONLY_SCOPE) ||
    requestedScopes.some(
      (scope) =>
        !ALLOWED_OAUTH_SCOPES.has(scope) ||
        (scope === YOUTUBE_FORCE_SSL_SCOPE &&
          input.capabilities?.comments !== true),
    )
  ) {
    throw new UserInputError(
      "OAuth 必须包含 YouTube 只读范围，且只允许请求已支持的频道、Analytics 或评论读取范围。",
    );
  }

  const paths = await resolveWorkflowPaths(configPath);
  const stateStore = await loadState(paths.statePath);
  const now = (dependencies.now ?? (() => new Date()))();
  const state =
    dependencies.stateFactory?.() ?? randomBytes(32).toString("base64url");
  if (state.length < 16) {
    throw new UserInputError("OAuth state 长度不足，无法安全启动授权。");
  }

  const pendingAuth: PendingAuth = {
    stateHash: stateHash(state),
    redirectUri: input.redirectUri,
    clientId: input.clientId,
    createdAt: now.toISOString(),
    scopes: requestedScopes,
  };
  await saveState(paths.statePath, { ...stateStore, pendingAuth });

  const provider = dependencies.provider ?? new GoogleOAuthProvider();
  return {
    authorizationUrl: provider.createAuthorizationUrl({
      state,
      redirectUri: input.redirectUri,
      clientId: input.clientId,
      scopes: pendingAuth.scopes ?? [YOUTUBE_READONLY_SCOPE],
    }),
    state,
    redirectUri: input.redirectUri,
    scopes: pendingAuth.scopes ?? [YOUTUBE_READONLY_SCOPE],
    selectionRequired: true,
  };
}

export async function completeChannelOAuth(
  configPath: string,
  input: { code: string; state: string; clientSecret?: string },
  dependencies: OAuthWorkflowDependencies = {},
): Promise<ChannelConnectionStatus> {
  if (input.code.trim().length === 0) {
    throw new UserInputError("OAuth 授权码不能为空。");
  }

  const paths = await resolveWorkflowPaths(configPath);
  const stateStore = await loadState(paths.statePath);
  const pending = stateStore.pendingAuth;
  if (pending === undefined) {
    throw new UserInputError("没有待完成的 OAuth 授权，请先启动授权。");
  }
  const now = (dependencies.now ?? (() => new Date()))();
  const pendingCreatedAt = new Date(pending.createdAt).getTime();
  if (
    Number.isNaN(pendingCreatedAt) ||
    now.getTime() < pendingCreatedAt ||
    now.getTime() - pendingCreatedAt > STATE_LIFETIME_MS
  ) {
    throw new UserInputError("OAuth state 已过期，请重新启动授权。");
  }
  if (!statesMatch(input.state, pending.stateHash)) {
    throw new UserInputError("OAuth state 校验失败，拒绝交换授权码。");
  }

  const provider = dependencies.provider ?? new GoogleOAuthProvider();
  const credentialStore =
    dependencies.credentialStore ??
    createDefaultCredentialStore(paths.credentialPath);
  const secretStore =
    dependencies.secretStore ?? asProtectedSecretStore(credentialStore);
  const configuredClientSecret = input.clientSecret?.trim();
  const clientSecret =
    configuredClientSecret ||
    (await secretStore?.getSecret(GOOGLE_CLIENT_SECRET_KEY))?.trim();
  if (clientSecret === undefined || clientSecret.length === 0) {
    throw new UserInputError(
      "未配置 Google OAuth 客户端秘密。请先通过受保护凭据存储准备客户端秘密。",
    );
  }
  const token = await provider.exchangeCode({
    code: input.code,
    redirectUri: pending.redirectUri,
    clientId: pending.clientId,
    clientSecret,
  });
  if (token.refreshToken.trim().length === 0) {
    throw new OAuthServiceError(
      "OAuth 授权未返回可持久化的刷新令牌，请重新授权并同意离线访问。",
    );
  }
  const channels = await provider.listChannels({
    accessToken: token.accessToken,
  });
  if (channels.length === 0) {
    throw new OAuthServiceError("当前授权用户没有可访问的 YouTube 频道。");
  }

  await secretStore?.setSecret(GOOGLE_CLIENT_SECRET_KEY, clientSecret);
  const credentialRef = randomUUID();
  await credentialStore.set(credentialRef, token);
  try {
    await saveState(paths.statePath, {
      ...stateStore,
      pendingAuth: undefined,
      availableChannels: channels,
      selectionCredentialRef: credentialRef,
      selectionScopes: pending.scopes ?? [YOUTUBE_READONLY_SCOPE],
    });
  } catch (error) {
    await credentialStore.remove(credentialRef).catch(() => undefined);
    throw error;
  }

  return toPublicStatus(
    {
      ...stateStore,
      pendingAuth: undefined,
      availableChannels: channels,
      selectionCredentialRef: credentialRef,
      selectionScopes: pending.scopes ?? [YOUTUBE_READONLY_SCOPE],
    },
    credentialStore,
    now,
    provider,
  );
}

export async function selectChannelConnection(
  configPath: string,
  channelId: string,
  dependencies: OAuthWorkflowDependencies = {},
): Promise<ChannelConnectionStatus> {
  if (channelId.trim().length === 0) {
    throw new UserInputError("必须提供目标频道 ID。");
  }
  const paths = await resolveWorkflowPaths(configPath);
  const state = await loadState(paths.statePath);
  const credentialRef = state.selectionCredentialRef;
  if (credentialRef === undefined) {
    throw new UserInputError("没有待选择的频道，请先完成 OAuth 授权。");
  }
  const channel = state.availableChannels.find(
    (candidate) => candidate.id === channelId,
  );
  if (channel === undefined) {
    throw new UserInputError(
      "目标频道不在当前 OAuth 可访问频道列表中，请先重新授权。",
    );
  }
  const credentialStore =
    dependencies.credentialStore ??
    createDefaultCredentialStore(paths.credentialPath);
  if ((await credentialStore.get(credentialRef)) === undefined) {
    throw new OAuthServiceError("找不到当前频道接入关联的受保护 OAuth 凭据。");
  }

  const now = (dependencies.now ?? (() => new Date()))();
  const connectedAt = now.toISOString();
  const existing = state.connections.find(
    (connection) => connection.channelId === channel.id,
  );
  const connection: StoredConnection = {
    connectionId: existing?.connectionId ?? randomUUID(),
    channelId: channel.id,
    title: channel.title,
    ...(channel.description === undefined
      ? {}
      : { description: channel.description }),
    ...(channel.uploadsPlaylistId === undefined
      ? {}
      : { uploadsPlaylistId: channel.uploadsPlaylistId }),
    status: "connected",
    credentialRef,
    scopes: state.selectionScopes ?? [YOUTUBE_READONLY_SCOPE],
    connectedAt: existing?.connectedAt ?? connectedAt,
    updatedAt: connectedAt,
  };
  const nextState: ConnectionStateFile = {
    ...state,
    selectionCredentialRef: undefined,
    selectionScopes: undefined,
    selectedChannelId: channel.id,
    connections: [
      ...state.connections.filter(
        (candidate) => candidate.channelId !== channel.id,
      ),
      connection,
    ],
  };
  await saveState(paths.statePath, nextState);
  return toPublicStatus(nextState, credentialStore, now, dependencies.provider);
}

export async function getChannelConnectionStatus(
  configPath: string,
  dependencies: Pick<
    OAuthWorkflowDependencies,
    "credentialStore" | "provider" | "now"
  > = {},
): Promise<ChannelConnectionStatus> {
  const paths = await resolveWorkflowPaths(configPath);
  const credentialStore =
    dependencies.credentialStore ??
    createDefaultCredentialStore(paths.credentialPath);
  return toPublicStatus(
    await loadState(paths.statePath),
    credentialStore,
    (dependencies.now ?? (() => new Date()))(),
    dependencies.provider,
  );
}

export async function getChannelAccessToken(
  configPath: string,
  channelId?: string,
  dependencies: Pick<OAuthWorkflowDependencies, "credentialStore" | "now"> = {},
): Promise<{ channelId: string; accessToken: string }> {
  const paths = await resolveWorkflowPaths(configPath);
  const state = await loadState(paths.statePath);
  const targetChannelId = channelId?.trim() || state.selectedChannelId;
  if (targetChannelId === undefined) {
    throw new UserInputError("尚未显式选择频道，无法读取频道数据。");
  }
  const connection = state.connections.find(
    (candidate) => candidate.channelId === targetChannelId,
  );
  if (connection === undefined) {
    throw new UserInputError("目标频道尚未建立频道接入。");
  }
  const credentialStore =
    dependencies.credentialStore ??
    createDefaultCredentialStore(paths.credentialPath);
  const token = await credentialStore.get(connection.credentialRef);
  if (token === undefined) {
    throw new OAuthServiceError(
      "找不到当前频道接入关联的受保护 OAuth 凭据，请重新授权。",
    );
  }
  if (token.expiresAt !== undefined) {
    const expiresAt = Date.parse(token.expiresAt);
    if (
      !Number.isNaN(expiresAt) &&
      expiresAt <= (dependencies.now ?? (() => new Date()))().getTime()
    ) {
      throw new OAuthServiceError("OAuth 访问令牌已过期，请重新完成授权。");
    }
  }
  return { channelId: connection.channelId, accessToken: token.accessToken };
}
