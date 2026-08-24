import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { validateChannelOperationsConfig } from "./config.js";
import { CommentsServiceError, UserInputError } from "./errors.js";
import {
  getChannelAccessToken,
  type OAuthWorkflowDependencies,
} from "./oauth.js";

export interface CommentItem {
  id: string;
  videoId?: string;
  parentId?: string;
  authorDisplayName?: string;
  text?: string;
  publishedAt?: string;
  updatedAt?: string;
  replyCount?: number;
  repliesAvailable: boolean;
}

export interface CommentsProvider {
  listComments(input: {
    accessToken: string;
    channelId: string;
    pageToken?: string;
  }): Promise<{ items: CommentItem[]; nextPageToken?: string; raw: unknown }>;
}

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

const COMMENT_THREADS_ENDPOINT =
  "https://www.googleapis.com/youtube/v3/commentThreads";

export class GoogleCommentsProvider implements CommentsProvider {
  constructor(
    private readonly fetcher: Fetcher = globalThis.fetch.bind(globalThis),
  ) {}

  async listComments(input: {
    accessToken: string;
    channelId: string;
    pageToken?: string;
  }): Promise<{ items: CommentItem[]; nextPageToken?: string; raw: unknown }> {
    const url = new URL(COMMENT_THREADS_ENDPOINT);
    url.search = new URLSearchParams({
      part: "snippet,replies",
      allThreadsRelatedToChannelId: input.channelId,
      maxResults: "100",
      ...(input.pageToken === undefined ? {} : { pageToken: input.pageToken }),
    }).toString();
    let response: Response;
    try {
      response = await this.fetcher(url, {
        headers: { authorization: `Bearer ${input.accessToken}` },
      });
    } catch {
      throw new CommentsServiceError(
        "读取官方评论时网络连接失败。",
        "network",
        true,
      );
    }
    const payload = await readJson(response);
    if (!response.ok) {
      if (response.status === 401)
        throw new CommentsServiceError(
          "评论 OAuth 凭据无效或已过期。",
          "credential",
          false,
        );
      if (response.status === 403)
        throw new CommentsServiceError(
          "当前频道评论读取权限不足或不具备资格。",
          "permission",
          false,
        );
      if (response.status === 429)
        throw new CommentsServiceError(
          "评论读取触发官方 API 配额限制。",
          "quota",
          true,
        );
      throw new CommentsServiceError(
        "官方评论 API 请求失败。",
        "network",
        response.status >= 500,
      );
    }
    if (!isRecord(payload) || !Array.isArray(payload.items)) {
      throw new CommentsServiceError(
        "官方评论 API 返回格式无效。",
        "invalid-response",
        false,
      );
    }
    const items = payload.items.flatMap((item) => parseCommentItem(item));
    return {
      items,
      raw: payload,
      ...(typeof payload.nextPageToken === "string"
        ? { nextPageToken: payload.nextPageToken }
        : {}),
    };
  }
}

export type CommentsRunStatus =
  "not-started" | "running" | "partial" | "completed" | "failed";
export type CommentsCoverageStatus =
  "complete" | "partial" | "permission-denied" | "unavailable";

export interface CommentsState {
  version: 1;
  channelId: string;
  status: CommentsRunStatus;
  coverage: CommentsCoverageStatus;
  checkpoint: { pageToken?: string };
  pages: number;
  items: number;
  updatedAt: string;
  lastSuccessAt?: string;
  error?: { kind: string; message: string; retryable: boolean };
}

export interface CommentsData {
  version: 1;
  channelId: string;
  source: "youtube-data-api-commentThreads";
  comments: CommentItem[];
  evidence: Array<{ path: string; fetchedAt: string }>;
  dataAsOf?: string;
}

export interface CommentsResult {
  channelId: string;
  state: CommentsState;
  data: CommentsData;
}

export interface CommentsDependencies extends Pick<
  OAuthWorkflowDependencies,
  "credentialStore" | "now"
> {
  provider?: CommentsProvider;
}

interface CommentsPaths {
  state: string;
  data: string;
  evidence: string;
}

const commentSchema = z
  .object({
    id: z.string().min(1),
    videoId: z.string().optional(),
    parentId: z.string().optional(),
    authorDisplayName: z.string().optional(),
    text: z.string().optional(),
    publishedAt: z.string().optional(),
    updatedAt: z.string().optional(),
    replyCount: z.number().int().nonnegative().optional(),
    repliesAvailable: z.boolean(),
  })
  .strict();

const stateSchema = z
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
    coverage: z.enum([
      "complete",
      "partial",
      "permission-denied",
      "unavailable",
    ]),
    checkpoint: z.object({ pageToken: z.string().min(1).optional() }).strict(),
    pages: z.number().int().nonnegative(),
    items: z.number().int().nonnegative(),
    updatedAt: z.string().min(1),
    lastSuccessAt: z.string().min(1).optional(),
    error: z
      .object({ kind: z.string(), message: z.string(), retryable: z.boolean() })
      .strict()
      .optional(),
  })
  .strict() as unknown as z.ZodType<CommentsState>;

const dataSchema = z
  .object({
    version: z.literal(1),
    channelId: z.string().min(1),
    source: z.literal("youtube-data-api-commentThreads"),
    comments: z.array(commentSchema),
    evidence: z.array(
      z.object({ path: z.string(), fetchedAt: z.string() }).strict(),
    ),
    dataAsOf: z.string().optional(),
  })
  .strict() as unknown as z.ZodType<CommentsData>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function stringProperty(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string"
    ? value[key]
    : undefined;
}

function parseCommentItem(value: unknown): CommentItem[] {
  if (!isRecord(value)) return [];
  const id = stringProperty(value, "id");
  const snippet = isRecord(value.snippet) ? value.snippet : undefined;
  const topLevel =
    snippet !== undefined && isRecord(snippet.topLevelComment)
      ? snippet.topLevelComment
      : undefined;
  const topLevelSnippet =
    topLevel !== undefined && isRecord(topLevel.snippet)
      ? topLevel.snippet
      : undefined;
  if (id === undefined || topLevelSnippet === undefined) return [];
  const replies =
    isRecord(value.replies) && Array.isArray(value.replies.comments)
      ? value.replies.comments
      : undefined;
  const replyCount =
    typeof snippet?.totalReplyCount === "number"
      ? snippet.totalReplyCount
      : undefined;
  return [
    {
      id,
      ...(stringProperty(snippet, "videoId") === undefined
        ? {}
        : { videoId: stringProperty(snippet, "videoId") }),
      ...(stringProperty(topLevelSnippet, "authorDisplayName") === undefined
        ? {}
        : {
            authorDisplayName: stringProperty(
              topLevelSnippet,
              "authorDisplayName",
            ),
          }),
      ...(stringProperty(topLevelSnippet, "textDisplay") === undefined
        ? {}
        : { text: stringProperty(topLevelSnippet, "textDisplay") }),
      ...(stringProperty(topLevelSnippet, "publishedAt") === undefined
        ? {}
        : { publishedAt: stringProperty(topLevelSnippet, "publishedAt") }),
      ...(stringProperty(topLevelSnippet, "updatedAt") === undefined
        ? {}
        : { updatedAt: stringProperty(topLevelSnippet, "updatedAt") }),
      ...(replyCount === undefined ? {} : { replyCount }),
      repliesAvailable: replies !== undefined || replyCount === 0,
    },
  ];
}

async function resolvePaths(
  configPath: string,
  channelId: string,
): Promise<CommentsPaths> {
  if (!/^UC[A-Za-z0-9_-]{22}$/.test(channelId))
    throw new UserInputError("频道 ID 必须是有效的 YouTube 频道 ID。");
  const validated = await validateChannelOperationsConfig(configPath);
  const root = resolve(
    dirname(validated.configPath),
    validated.config.global.dataDirectory,
    "comments",
    channelId,
  );
  return {
    state: resolve(root, "sync-state.json"),
    data: resolve(root, "data.json"),
    evidence: resolve(root, "evidence"),
  };
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

async function load<T>(
  path: string,
  fallback: T,
  schema: z.ZodType<T>,
): Promise<T> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const result = schema.safeParse(parsed);
    if (!result.success)
      throw new CommentsServiceError(
        "评论本机状态格式无效。",
        "invalid-response",
        false,
      );
    return result.data;
  } catch (error) {
    if (error instanceof CommentsServiceError) throw error;
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    )
      return fallback;
    throw new CommentsServiceError("无法读取评论本机状态。", "network", true);
  }
}

function emptyState(channelId: string, now: string): CommentsState {
  return {
    version: 1,
    channelId,
    status: "not-started",
    coverage: "partial",
    checkpoint: {},
    pages: 0,
    items: 0,
    updatedAt: now,
  };
}

function emptyData(channelId: string): CommentsData {
  return {
    version: 1,
    channelId,
    source: "youtube-data-api-commentThreads",
    comments: [],
    evidence: [],
  };
}

function normalizeError(error: unknown): {
  kind: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof CommentsServiceError)
    return {
      kind: error.kind,
      message: error.message,
      retryable: error.retryable,
    };
  if (error instanceof Error)
    return { kind: "network", message: error.message, retryable: true };
  return { kind: "network", message: "评论同步失败。", retryable: true };
}

export async function getCommentsStatus(
  configPath: string,
  channelId: string,
): Promise<CommentsResult> {
  const paths = await resolvePaths(configPath, channelId);
  const state = await load(
    paths.state,
    emptyState(channelId, new Date().toISOString()),
    stateSchema,
  );
  const data = await load(paths.data, emptyData(channelId), dataSchema);
  return { channelId, state, data };
}

export async function syncComments(
  configPath: string,
  input: { channelId: string; maxWorkUnits?: number },
  dependencies: CommentsDependencies = {},
): Promise<CommentsResult> {
  const nowFactory = dependencies.now ?? (() => new Date());
  const paths = await resolvePaths(configPath, input.channelId);
  let state = await load(
    paths.state,
    emptyState(input.channelId, nowFactory().toISOString()),
    stateSchema,
  );
  let data = await load(paths.data, emptyData(input.channelId), dataSchema);
  const provider = dependencies.provider;
  if (provider === undefined)
    throw new CommentsServiceError(
      "未配置评论官方适配器。",
      "unavailable",
      false,
    );
  state = {
    ...state,
    status: "running",
    updatedAt: nowFactory().toISOString(),
    error: undefined,
  };
  await saveJson(paths.state, state);
  let workUnits = 0;
  const canContinue = () =>
    input.maxWorkUnits === undefined || workUnits < input.maxWorkUnits;
  try {
    const access = await getChannelAccessToken(
      configPath,
      input.channelId,
      dependencies,
    );
    let pageToken = state.checkpoint.pageToken;
    while (canContinue()) {
      const result = await provider.listComments({
        accessToken: access.accessToken,
        channelId: access.channelId,
        ...(pageToken === undefined ? {} : { pageToken }),
      });
      const fetchedAt = nowFactory().toISOString();
      const evidencePath = resolve(
        paths.evidence,
        `${fetchedAt.replace(/[^0-9A-Za-z]/g, "-")}-${workUnits}.json`,
      );
      await saveJson(evidencePath, {
        source: "youtube-data-api-commentThreads",
        request: { channelId: access.channelId, pageToken },
        fetchedAt,
        response: result.raw,
      });
      const byId = new Map(
        data.comments.map((comment) => [comment.id, comment]),
      );
      for (const comment of result.items) byId.set(comment.id, comment);
      const mergedComments = [...byId.values()];
      data = {
        ...data,
        comments: mergedComments,
        evidence: [...data.evidence, { path: evidencePath, fetchedAt }],
        dataAsOf: fetchedAt,
      };
      pageToken = result.nextPageToken;
      state = {
        ...state,
        checkpoint:
          result.nextPageToken === undefined
            ? {}
            : { pageToken: result.nextPageToken },
        pages: state.pages + 1,
        items: byId.size,
        updatedAt: fetchedAt,
        coverage: mergedComments.some((comment) => !comment.repliesAvailable)
          ? "partial"
          : "complete",
      };
      await saveJson(paths.data, data);
      await saveJson(paths.state, state);
      workUnits += 1;
      if (result.nextPageToken === undefined) {
        const completedAt = nowFactory().toISOString();
        state = {
          ...state,
          status: "completed",
          updatedAt: completedAt,
          lastSuccessAt: completedAt,
        };
        await saveJson(paths.state, state);
        return { channelId: input.channelId, state, data };
      }
    }
    state = {
      ...state,
      status: "partial",
      updatedAt: nowFactory().toISOString(),
      error: {
        kind: "checkpoint",
        message: "评论同步已保存检查点，可继续执行。",
        retryable: true,
      },
    };
    await saveJson(paths.state, state);
    return { channelId: input.channelId, state, data };
  } catch (error) {
    const normalized = normalizeError(error);
    state = {
      ...state,
      status: data.comments.length > 0 ? "partial" : "failed",
      coverage:
        normalized.kind === "permission" ? "permission-denied" : "unavailable",
      updatedAt: nowFactory().toISOString(),
      error: normalized,
    };
    await saveJson(paths.state, state);
    return { channelId: input.channelId, state, data };
  }
}
