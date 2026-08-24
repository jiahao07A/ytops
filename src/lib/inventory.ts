import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  type ChannelSummary,
  getChannelAccessToken,
  type CredentialStore,
  type OAuthWorkflowDependencies,
} from "./oauth.js";
import { InventoryServiceError, UserInputError } from "./errors.js";
import { validateChannelOperationsConfig } from "./config.js";

export type InventoryScopeName = "channel" | "uploads" | "videos";

export interface InventoryScope {
  channel: boolean;
  uploads: boolean;
  videos: boolean;
}

export const DEFAULT_INVENTORY_SCOPE: InventoryScope = {
  channel: true,
  uploads: true,
  videos: true,
};

export function parseInventoryScope(value: string | undefined): InventoryScope {
  if (value === undefined || value.trim().length === 0) {
    return { ...DEFAULT_INVENTORY_SCOPE };
  }

  const scope: InventoryScope = {
    channel: false,
    uploads: false,
    videos: false,
  };
  for (const rawItem of value.split(",")) {
    const item = rawItem.trim().toLowerCase();
    if (item === "channel" || item === "channels") {
      scope.channel = true;
    } else if (
      item === "uploads" ||
      item === "upload-playlist" ||
      item === "uploads-playlist"
    ) {
      scope.uploads = true;
    } else if (item === "videos" || item === "video") {
      scope.videos = true;
    } else {
      throw new UserInputError(
        `不支持的元数据同步范围 ${rawItem}。可选值：channel、uploads、videos。`,
      );
    }
  }
  if (!scope.channel && !scope.uploads && !scope.videos) {
    throw new UserInputError("元数据同步范围至少要包含一个数据类别。");
  }
  return scope;
}

export interface InventoryChannel {
  id: string;
  title: string;
  description?: string;
  uploadsPlaylistId?: string;
  fetchedAt: string;
}

export interface InventoryUploadItem {
  playlistItemId: string;
  videoId: string;
  title: string;
  publishedAt?: string;
  position?: number;
  fetchedAt: string;
}

export interface InventoryVideo {
  id: string;
  channelId?: string;
  title: string;
  description?: string;
  publishedAt?: string;
  duration?: string;
  viewCount?: number;
  likeCount?: number;
  commentCount?: number;
  fetchedAt: string;
}

export interface InventoryData {
  version: 1;
  channelId: string;
  source: "youtube-data-api";
  channel?: InventoryChannel;
  uploads: InventoryUploadItem[];
  videos: InventoryVideo[];
  updatedAt?: string;
  dataAsOf?: string;
}

export type InventoryPhase = "channels" | "uploads" | "videos" | "complete";
export type InventoryRunStatus =
  "not-started" | "running" | "partial" | "completed" | "failed";

export interface InventorySyncState {
  version: 1;
  channelId: string;
  status: InventoryRunStatus;
  scope: InventoryScope;
  phase: InventoryPhase;
  progress: {
    pages: number;
    items: number;
    videoItems: number;
  };
  checkpoint: {
    uploadPageToken?: string;
    videoIndex: number;
    videoIds: string[];
  };
  startedAt?: string;
  updatedAt: string;
  lastSuccessAt?: string;
  dataAsOf?: string;
  error?: {
    kind: string;
    message: string;
    retryable: boolean;
  };
}

export interface InventorySyncResult {
  channelId: string;
  state: InventorySyncState;
  data: InventoryData;
}

export interface InventoryPage<T> {
  items: T[];
  nextPageToken?: string;
  raw: unknown;
}

export interface InventoryProvider {
  listChannel(input: {
    accessToken: string;
    channelId: string;
  }): Promise<{ item: InventoryChannel; raw: unknown }>;
  listUploads(input: {
    accessToken: string;
    playlistId: string;
    pageToken?: string;
  }): Promise<InventoryPage<InventoryUploadItem>>;
  listVideos(input: {
    accessToken: string;
    videoIds: string[];
  }): Promise<{ items: InventoryVideo[]; raw: unknown }>;
}

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

const CHANNELS_ENDPOINT = "https://www.googleapis.com/youtube/v3/channels";
const PLAYLIST_ITEMS_ENDPOINT =
  "https://www.googleapis.com/youtube/v3/playlistItems";
const VIDEOS_ENDPOINT = "https://www.googleapis.com/youtube/v3/videos";

export class GoogleInventoryProvider implements InventoryProvider {
  constructor(
    private readonly fetcher: Fetcher = globalThis.fetch.bind(globalThis),
  ) {}

  async listChannel(input: {
    accessToken: string;
    channelId: string;
  }): Promise<{ item: InventoryChannel; raw: unknown }> {
    const url = new URL(CHANNELS_ENDPOINT);
    url.search = new URLSearchParams({
      part: "snippet,contentDetails",
      id: input.channelId,
    }).toString();
    const payload = await this.request(url, input.accessToken);
    const item = firstRecordItem(payload);
    if (item === undefined) {
      throw new InventoryServiceError(
        "官方 API 没有返回目标频道，频道可能已不可用。",
        "permission",
        false,
      );
    }
    const snippet = isRecord(item.snippet) ? item.snippet : undefined;
    const contentDetails = isRecord(item.contentDetails)
      ? item.contentDetails
      : undefined;
    const relatedPlaylists =
      contentDetails !== undefined && isRecord(contentDetails.relatedPlaylists)
        ? contentDetails.relatedPlaylists
        : undefined;
    const id = stringProperty(item, "id") ?? input.channelId;
    const title =
      snippet === undefined ? undefined : stringProperty(snippet, "title");
    if (title === undefined) {
      throw new InventoryServiceError(
        "官方 API 返回的频道元数据格式无效。",
        "invalid-response",
        false,
      );
    }
    return {
      item: {
        id,
        title,
        ...(snippet === undefined
          ? {}
          : optionalString(snippet, "description")),
        ...(relatedPlaylists === undefined
          ? {}
          : optionalString(relatedPlaylists, "uploads", "uploadsPlaylistId")),
        fetchedAt: new Date().toISOString(),
      },
      raw: payload,
    };
  }

  async listUploads(input: {
    accessToken: string;
    playlistId: string;
    pageToken?: string;
  }): Promise<InventoryPage<InventoryUploadItem>> {
    const url = new URL(PLAYLIST_ITEMS_ENDPOINT);
    url.search = new URLSearchParams({
      part: "snippet,contentDetails,status",
      playlistId: input.playlistId,
      maxResults: "50",
      ...(input.pageToken === undefined ? {} : { pageToken: input.pageToken }),
    }).toString();
    const payload = await this.request(url, input.accessToken);
    const items = arrayProperty(payload, "items").flatMap((rawItem) => {
      if (!isRecord(rawItem)) {
        return [];
      }
      const playlistItemId = stringProperty(rawItem, "id");
      const snippet = isRecord(rawItem.snippet) ? rawItem.snippet : undefined;
      const contentDetails = isRecord(rawItem.contentDetails)
        ? rawItem.contentDetails
        : undefined;
      const videoId =
        contentDetails === undefined
          ? undefined
          : stringProperty(contentDetails, "videoId");
      const title =
        snippet === undefined ? undefined : stringProperty(snippet, "title");
      if (
        playlistItemId === undefined ||
        videoId === undefined ||
        title === undefined
      ) {
        return [];
      }
      return [
        {
          playlistItemId,
          videoId,
          title,
          ...(snippet === undefined
            ? {}
            : optionalString(snippet, "publishedAt")),
          ...(snippet === undefined ? {} : optionalNumber(snippet, "position")),
          fetchedAt: new Date().toISOString(),
        },
      ];
    });
    return {
      items,
      ...(optionalStringProperty(payload, "nextPageToken") === undefined
        ? {}
        : { nextPageToken: optionalStringProperty(payload, "nextPageToken") }),
      raw: payload,
    };
  }

  async listVideos(input: {
    accessToken: string;
    videoIds: string[];
  }): Promise<{ items: InventoryVideo[]; raw: unknown }> {
    if (input.videoIds.length === 0) {
      return { items: [], raw: { items: [] } };
    }
    const url = new URL(VIDEOS_ENDPOINT);
    url.search = new URLSearchParams({
      part: "snippet,contentDetails,statistics",
      id: input.videoIds.join(","),
    }).toString();
    const payload = await this.request(url, input.accessToken);
    const items = arrayProperty(payload, "items").flatMap((rawItem) => {
      if (!isRecord(rawItem)) {
        return [];
      }
      const id = stringProperty(rawItem, "id");
      const snippet = isRecord(rawItem.snippet) ? rawItem.snippet : undefined;
      const contentDetails = isRecord(rawItem.contentDetails)
        ? rawItem.contentDetails
        : undefined;
      const statistics = isRecord(rawItem.statistics)
        ? rawItem.statistics
        : undefined;
      const title =
        snippet === undefined ? undefined : stringProperty(snippet, "title");
      if (id === undefined || title === undefined) {
        return [];
      }
      return [
        {
          id,
          ...(snippet === undefined
            ? {}
            : optionalString(snippet, "channelId")),
          title,
          ...(snippet === undefined
            ? {}
            : optionalString(snippet, "description")),
          ...(snippet === undefined
            ? {}
            : optionalString(snippet, "publishedAt")),
          ...(contentDetails === undefined
            ? {}
            : optionalString(contentDetails, "duration")),
          ...(statistics === undefined
            ? {}
            : optionalNumberFromString(statistics, "viewCount")),
          ...(statistics === undefined
            ? {}
            : optionalNumberFromString(statistics, "likeCount")),
          ...(statistics === undefined
            ? {}
            : optionalNumberFromString(statistics, "commentCount")),
          fetchedAt: new Date().toISOString(),
        },
      ];
    });
    return { items, raw: payload };
  }

  private async request(url: URL, accessToken: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
    } catch {
      throw new InventoryServiceError(
        "读取官方频道元数据时网络连接失败。",
        "network",
        true,
      );
    }
    const payload = await readJson(response);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new InventoryServiceError(
          "官方 API 拒绝读取频道元数据，请检查授权、频道资格或配额状态。",
          response.status === 403 ? "permission" : "credential",
          response.status !== 401,
        );
      }
      throw new InventoryServiceError(
        "官方频道元数据请求失败。",
        "network",
        response.status >= 500,
      );
    }
    return payload;
  }
}

interface InventoryPaths {
  root: string;
  state: string;
  data: string;
  evidence: string;
}

async function resolveInventoryPaths(
  configPath: string,
  channelId: string,
): Promise<InventoryPaths> {
  if (!/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) {
    throw new UserInputError("频道 ID 必须是有效的 YouTube 频道 ID。");
  }
  const validated = await validateChannelOperationsConfig(configPath);
  const dataDirectory = resolve(
    dirname(validated.configPath),
    validated.config.global.dataDirectory,
  );
  const root = resolve(dataDirectory, "inventory", channelId);
  return {
    root,
    state: resolve(root, "sync-state.json"),
    data: resolve(root, "data.json"),
    evidence: resolve(root, "evidence"),
  };
}

const inventoryStateSchema = z
  .object({
    version: z.literal(1),
    channelId: z.string().min(1),
    status: z.enum([
      "not-started",
      "running",
      "partial",
      "completed",
      "failed",
    ]),
    scope: z.object({
      channel: z.boolean(),
      uploads: z.boolean(),
      videos: z.boolean(),
    }),
    phase: z.enum(["channels", "uploads", "videos", "complete"]),
    progress: z.object({
      pages: z.number().int().nonnegative(),
      items: z.number().int().nonnegative(),
      videoItems: z.number().int().nonnegative(),
    }),
    checkpoint: z.object({
      uploadPageToken: z.string().min(1).optional(),
      videoIndex: z.number().int().nonnegative(),
      videoIds: z.array(z.string().min(1)),
    }),
    startedAt: z.string().min(1).optional(),
    updatedAt: z.string().min(1),
    lastSuccessAt: z.string().min(1).optional(),
    dataAsOf: z.string().min(1).optional(),
    error: z
      .object({
        kind: z.string().min(1),
        message: z.string().min(1),
        retryable: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();

const inventoryDataSchema = z
  .object({
    version: z.literal(1),
    channelId: z.string().min(1),
    source: z.literal("youtube-data-api"),
    channel: z
      .object({
        id: z.string().min(1),
        title: z.string().min(1),
        description: z.string().optional(),
        uploadsPlaylistId: z.string().min(1).optional(),
        fetchedAt: z.string().min(1),
      })
      .strict()
      .optional(),
    uploads: z.array(
      z
        .object({
          playlistItemId: z.string().min(1),
          videoId: z.string().min(1),
          title: z.string().min(1),
          publishedAt: z.string().optional(),
          position: z.number().int().nonnegative().optional(),
          fetchedAt: z.string().min(1),
        })
        .strict(),
    ),
    videos: z.array(
      z
        .object({
          id: z.string().min(1),
          channelId: z.string().optional(),
          title: z.string().min(1),
          description: z.string().optional(),
          publishedAt: z.string().optional(),
          duration: z.string().optional(),
          viewCount: z.number().nonnegative().optional(),
          likeCount: z.number().nonnegative().optional(),
          commentCount: z.number().nonnegative().optional(),
          fetchedAt: z.string().min(1),
        })
        .strict(),
    ),
    updatedAt: z.string().min(1).optional(),
    dataAsOf: z.string().min(1).optional(),
  })
  .strict() as unknown as z.ZodType<InventoryData>;

function emptyState(channelId: string, now: string): InventorySyncState {
  return {
    version: 1,
    channelId,
    status: "not-started",
    scope: { ...DEFAULT_INVENTORY_SCOPE },
    phase: "channels",
    progress: { pages: 0, items: 0, videoItems: 0 },
    checkpoint: { videoIndex: 0, videoIds: [] },
    updatedAt: now,
  };
}

function emptyData(channelId: string): InventoryData {
  return {
    version: 1,
    channelId,
    source: "youtube-data-api",
    uploads: [],
    videos: [],
  };
}

async function loadJson<T>(
  path: string,
  fallback: T,
  schema: z.ZodType<T>,
): Promise<T> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      throw new InventoryServiceError(
        "本机频道数据文件格式无效，请先保留证据后重新同步。",
        "invalid-response",
        false,
      );
    }
    return validated.data;
  } catch (error) {
    if (error instanceof InventoryServiceError) {
      throw error;
    }
    if (isFsCode(error, "ENOENT")) {
      return fallback;
    }
    throw new InventoryServiceError(
      "无法读取本机频道数据文件。",
      "network",
      true,
    );
  }
}

async function saveJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

async function saveEvidence(
  paths: InventoryPaths,
  phase: string,
  request: Record<string, unknown>,
  raw: unknown,
  fetchedAt: string,
): Promise<string> {
  const evidencePath = resolve(
    paths.evidence,
    `${fetchedAt.replace(/[^0-9A-Za-z]/g, "-")}-${phase}-${randomUUID()}.json`,
  );
  await saveJson(evidencePath, {
    source: "youtube-data-api",
    phase,
    request,
    fetchedAt,
    response: raw,
  });
  return evidencePath;
}

export async function getInventoryStatus(
  configPath: string,
  channelId: string,
): Promise<InventorySyncResult> {
  const paths = await resolveInventoryPaths(configPath, channelId);
  const now = new Date().toISOString();
  const state = await loadJson(
    paths.state,
    emptyState(channelId, now),
    inventoryStateSchema,
  );
  const data = await loadJson(
    paths.data,
    emptyData(channelId),
    inventoryDataSchema,
  );
  return { channelId, state, data };
}

export interface InventorySyncDependencies extends Pick<
  OAuthWorkflowDependencies,
  "credentialStore" | "now"
> {
  provider?: InventoryProvider;
}

export async function syncInventory(
  configPath: string,
  input: {
    channelId: string;
    scope?: InventoryScope;
    maxWorkUnits?: number;
  },
  dependencies: InventorySyncDependencies = {},
): Promise<InventorySyncResult> {
  const nowFactory = dependencies.now ?? (() => new Date());
  const paths = await resolveInventoryPaths(configPath, input.channelId);
  const now = nowFactory().toISOString();
  const previousState = await loadJson(
    paths.state,
    emptyState(input.channelId, now),
    inventoryStateSchema,
  );
  let state = previousState;
  let data = await loadJson(
    paths.data,
    emptyData(input.channelId),
    inventoryDataSchema,
  );
  const scope = input.scope ?? { ...DEFAULT_INVENTORY_SCOPE };
  const shouldResume =
    input.scope === undefined &&
    (previousState.status === "partial" || previousState.status === "failed");
  if (!shouldResume) {
    state = {
      ...emptyState(input.channelId, now),
      scope,
      status: "running",
      startedAt: now,
    };
  } else {
    state = {
      ...previousState,
      status: "running",
      updatedAt: now,
      error: undefined,
    };
  }
  await saveJson(paths.state, state);

  const provider = dependencies.provider ?? new GoogleInventoryProvider();
  let access: { channelId: string; accessToken: string };
  try {
    access = await getChannelAccessToken(
      configPath,
      input.channelId,
      dependencies,
    );
  } catch (error) {
    return finishInventoryFailure(state, data, paths, now, error);
  }

  let workUnits = 0;
  const canContinue = () =>
    input.maxWorkUnits === undefined || workUnits < input.maxWorkUnits;
  try {
    if ((scope.channel || scope.uploads) && canContinue()) {
      const result = await provider.listChannel({
        accessToken: access.accessToken,
        channelId: access.channelId,
      });
      const fetchedAt = nowFactory().toISOString();
      data = {
        ...data,
        channel: { ...result.item, fetchedAt },
        updatedAt: fetchedAt,
        dataAsOf: fetchedAt,
      };
      await saveEvidence(
        paths,
        "channel",
        { channelId: access.channelId },
        result.raw,
        fetchedAt,
      );
      state = {
        ...state,
        phase: scope.uploads ? "uploads" : scope.videos ? "videos" : "complete",
        progress: { ...state.progress, items: state.progress.items + 1 },
        updatedAt: fetchedAt,
      };
      await saveJson(paths.data, data);
      await saveJson(paths.state, state);
      workUnits += 1;
    }

    const uploadsPlaylistId = data.channel?.uploadsPlaylistId;
    if (scope.uploads && uploadsPlaylistId === undefined) {
      throw new InventoryServiceError(
        "目标频道没有可读取的上传播放列表，无法完成上传清单同步。",
        "permission",
        false,
      );
    }
    if (scope.uploads && uploadsPlaylistId !== undefined) {
      state = { ...state, phase: "uploads" };
      let pageToken = state.checkpoint.uploadPageToken;
      while (canContinue()) {
        const result = await provider.listUploads({
          accessToken: access.accessToken,
          playlistId: uploadsPlaylistId,
          ...(pageToken === undefined ? {} : { pageToken }),
        });
        const fetchedAt = nowFactory().toISOString();
        await saveEvidence(
          paths,
          "uploads",
          {
            channelId: access.channelId,
            playlistId: uploadsPlaylistId,
            pageToken,
          },
          result.raw,
          fetchedAt,
        );
        const uploadById = new Map(
          data.uploads.map((item) => [item.playlistItemId, item]),
        );
        for (const item of result.items) {
          uploadById.set(item.playlistItemId, { ...item, fetchedAt });
        }
        data = {
          ...data,
          uploads: [...uploadById.values()],
          updatedAt: fetchedAt,
          dataAsOf: fetchedAt,
        };
        pageToken = result.nextPageToken;
        state = {
          ...state,
          phase: result.nextPageToken === undefined ? "videos" : "uploads",
          progress: {
            ...state.progress,
            pages: state.progress.pages + 1,
            items: state.progress.items + result.items.length,
          },
          checkpoint: {
            ...state.checkpoint,
            uploadPageToken: result.nextPageToken,
            videoIds: unique([
              ...state.checkpoint.videoIds,
              ...result.items.map((item) => item.videoId),
            ]),
          },
          updatedAt: fetchedAt,
        };
        await saveJson(paths.data, data);
        await saveJson(paths.state, state);
        workUnits += 1;
        if (result.nextPageToken === undefined) {
          break;
        }
      }
    }

    const videoIds = unique([
      ...state.checkpoint.videoIds,
      ...data.uploads.map((item) => item.videoId),
    ]);
    if (scope.videos && videoIds.length > state.checkpoint.videoIndex) {
      state = {
        ...state,
        phase: "videos",
        checkpoint: { ...state.checkpoint, videoIds },
      };
      while (canContinue() && state.checkpoint.videoIndex < videoIds.length) {
        const batch = videoIds.slice(
          state.checkpoint.videoIndex,
          state.checkpoint.videoIndex + 50,
        );
        const result = await provider.listVideos({
          accessToken: access.accessToken,
          videoIds: batch,
        });
        const fetchedAt = nowFactory().toISOString();
        await saveEvidence(
          paths,
          "videos",
          { channelId: access.channelId, videoIds: batch },
          result.raw,
          fetchedAt,
        );
        const videoById = new Map(data.videos.map((item) => [item.id, item]));
        for (const item of result.items) {
          videoById.set(item.id, { ...item, fetchedAt });
        }
        data = {
          ...data,
          videos: [...videoById.values()],
          updatedAt: fetchedAt,
          dataAsOf: fetchedAt,
        };
        state = {
          ...state,
          progress: {
            ...state.progress,
            pages: state.progress.pages + 1,
            videoItems: state.progress.videoItems + result.items.length,
          },
          checkpoint: {
            ...state.checkpoint,
            videoIds,
            videoIndex: state.checkpoint.videoIndex + batch.length,
          },
          updatedAt: fetchedAt,
        };
        await saveJson(paths.data, data);
        await saveJson(paths.state, state);
        workUnits += 1;
      }
    }

    const uploadsComplete =
      !scope.uploads || state.phase === "videos" || state.phase === "complete";
    const videosComplete =
      !scope.videos || state.checkpoint.videoIndex >= videoIds.length;
    const complete =
      uploadsComplete &&
      videosComplete &&
      (!scope.channel || data.channel !== undefined) &&
      (input.maxWorkUnits === undefined ||
        workUnits < input.maxWorkUnits ||
        state.phase === "complete");
    const completedAt = nowFactory().toISOString();
    state = {
      ...state,
      status: complete ? "completed" : "partial",
      phase: complete ? "complete" : state.phase,
      updatedAt: completedAt,
      ...(complete
        ? {
            lastSuccessAt: completedAt,
            dataAsOf: data.dataAsOf ?? completedAt,
            error: undefined,
          }
        : {
            error: {
              kind: "checkpoint",
              message: "本次同步已保存检查点，可继续执行以完成剩余范围。",
              retryable: true,
            },
          }),
    };
    data = {
      ...data,
      updatedAt: completedAt,
      dataAsOf: data.dataAsOf ?? completedAt,
    };
    await saveJson(paths.data, data);
    await saveJson(paths.state, state);
    return { channelId: input.channelId, state, data };
  } catch (error) {
    return finishInventoryFailure(
      state,
      data,
      paths,
      nowFactory().toISOString(),
      error,
    );
  }
}

async function finishInventoryFailure(
  state: InventorySyncState,
  data: InventoryData,
  paths: InventoryPaths,
  now: string,
  error: unknown,
): Promise<InventorySyncResult> {
  const normalized = normalizeInventoryError(error);
  const nextState: InventorySyncState = {
    ...state,
    status:
      data.channel !== undefined ||
      data.uploads.length > 0 ||
      data.videos.length > 0
        ? "partial"
        : "failed",
    updatedAt: now,
    error: normalized,
  };
  await saveJson(paths.state, nextState);
  return { channelId: state.channelId, state: nextState, data };
}

function normalizeInventoryError(error: unknown): {
  kind: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof InventoryServiceError) {
    return {
      kind: error.kind,
      message: error.message,
      retryable: error.retryable,
    };
  }
  if (error instanceof Error) {
    return { kind: "unknown", message: error.message, retryable: true };
  }
  return { kind: "unknown", message: "同步失败。", retryable: true };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function firstRecordItem(value: unknown): Record<string, unknown> | undefined {
  return arrayProperty(value, "items").find(isRecord);
}

function arrayProperty(value: unknown, key: string): unknown[] {
  return isRecord(value) && Array.isArray(value[key]) ? value[key] : [];
}

function stringProperty(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string"
    ? value[key]
    : undefined;
}

function optionalStringProperty(
  value: unknown,
  key: string,
): string | undefined {
  return stringProperty(value, key);
}

function optionalString(
  value: unknown,
  key: string,
  outputKey = key,
): Record<string, string> {
  const item = stringProperty(value, key);
  return item === undefined ? {} : { [outputKey]: item };
}

function optionalNumber(value: unknown, key: string): Record<string, number> {
  const item =
    isRecord(value) && typeof value[key] === "number" ? value[key] : undefined;
  return item === undefined ? {} : { [key]: item };
}

function optionalNumberFromString(
  value: unknown,
  key: string,
): Record<string, number> {
  const raw = stringProperty(value, key);
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return {};
  }
  return { [key]: Number(raw) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFsCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export async function pruneInventoryEvidence(
  configPath: string,
  channelId: string,
  before: Date,
): Promise<{ removed: number; channelId: string; before: string }> {
  const paths = await resolveInventoryPaths(configPath, channelId);
  let removed = 0;
  let entries: string[] = [];
  try {
    entries = await readdir(paths.evidence);
  } catch (error) {
    if (!isFsCode(error, "ENOENT")) {
      throw new InventoryServiceError(
        "无法读取原始证据目录。",
        "network",
        true,
      );
    }
  }
  for (const entry of entries) {
    const filePath = resolve(paths.evidence, entry);
    if (
      !filePath.startsWith(
        `${paths.evidence}${process.platform === "win32" ? "\\" : "/"}`,
      )
    ) {
      continue;
    }
    const timestamp = entry.slice(0, 24).replace(/-/g, ":");
    const fetchedAt = new Date(timestamp);
    if (!Number.isNaN(fetchedAt.getTime()) && fetchedAt < before) {
      await unlink(filePath);
      removed += 1;
    }
  }
  return { removed, channelId, before: before.toISOString() };
}
