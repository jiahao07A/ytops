export class UserInputError extends Error {
  readonly code = "USER_INPUT";

  constructor(message: string) {
    super(message);
    this.name = "UserInputError";
  }
}

export class ExternalCommandError extends Error {
  readonly code = "EXTERNAL_COMMAND";

  constructor(
    readonly command: string,
    readonly args: string[],
    readonly exitCode: number | undefined,
    readonly stderr: string,
  ) {
    super(
      `${command} failed${exitCode === undefined ? "" : ` with exit code ${exitCode}`}.`,
    );
    this.name = "ExternalCommandError";
  }
}

export class OAuthServiceError extends Error {
  readonly code = "OAUTH_SERVICE";

  constructor(message: string) {
    super(message);
    this.name = "OAuthServiceError";
  }
}

export type InventoryFailureKind =
  | "quota"
  | "network"
  | "permission"
  | "invalid-response"
  | "credential"
  | "conflict";

/**
 * 带 failure kind 与可重试标记的服务错误公共基类：CLI 的错误归一化只依赖
 * 这三个字段，新增服务错误类时继承它即可获得一致的 JSON 错误面。
 */
export abstract class KindedServiceError extends Error {
  abstract readonly code: string;
  abstract readonly kind: string;
  abstract readonly retryable: boolean;
}

export class InventoryServiceError extends KindedServiceError {
  readonly code = "INVENTORY_SERVICE";

  constructor(
    message: string,
    readonly kind: InventoryFailureKind,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "InventoryServiceError";
  }
}

export type AnalyticsFailureKind =
  | "quota"
  | "network"
  | "permission"
  | "invalid-response"
  | "credential"
  | "not-ready"
  | "conflict";

export class AnalyticsServiceError extends KindedServiceError {
  readonly code = "ANALYTICS_SERVICE";

  constructor(
    message: string,
    readonly kind: AnalyticsFailureKind,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AnalyticsServiceError";
  }
}

export type ReportingFailureKind =
  | "quota"
  | "network"
  | "permission"
  | "not-ready"
  | "invalid-response"
  | "credential";

export class ReportingServiceError extends KindedServiceError {
  readonly code = "REPORTING_SERVICE";

  constructor(
    message: string,
    readonly kind: ReportingFailureKind,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ReportingServiceError";
  }
}

export type CommentsFailureKind =
  | "quota"
  | "network"
  | "permission"
  | "credential"
  | "invalid-response"
  | "unavailable";

export class CommentsServiceError extends KindedServiceError {
  readonly code = "COMMENTS_SERVICE";

  constructor(
    message: string,
    readonly kind: CommentsFailureKind,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "CommentsServiceError";
  }
}

export const RETENTION_FAILURE_KINDS = [
  "quota",
  "network",
  "permission",
  "invalid-response",
  "credential",
  "not-ready",
] as const;

export type RetentionFailureKind = (typeof RETENTION_FAILURE_KINDS)[number];

export class RetentionServiceError extends KindedServiceError {
  readonly code = "RETENTION_SERVICE";

  constructor(
    message: string,
    readonly kind: RetentionFailureKind,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "RetentionServiceError";
  }
}

export interface HttpErrorFactories {
  credential: () => Error;
  quota: () => Error;
  permission: () => Error;
  rateLimited: () => Error;
  serverUnavailable: () => Error;
  requestFailed: () => Error;
}

export function httpErrorFactoriesFor<E extends KindedServiceError>(
  create: (message: string, kind: string, retryable: boolean) => E,
  label: string,
  credential: () => E,
  permission: () => E,
): HttpErrorFactories {
  return {
    credential,
    permission,
    quota: () =>
      create(
        `${label}官方 API 配额不足，请稍后重试或调整配额预算。`,
        "quota",
        true,
      ),
    rateLimited: () => create(`${label}请求触发配额限制。`, "quota", true),
    serverUnavailable: () =>
      create(`${label}官方 API 暂时不可用。`, "network", true),
    requestFailed: () =>
      create(`${label}官方 API 请求失败。`, "network", false),
  };
}

export function extractApiErrorReason(payload: unknown): string | undefined {
  const error = payload as { error?: { errors?: unknown[] } } | undefined;
  if (
    error === null ||
    typeof error !== "object" ||
    typeof error.error !== "object" ||
    error.error === null ||
    !Array.isArray(error.error.errors)
  ) {
    return undefined;
  }
  const first = error.error.errors.find(
    (entry): entry is { reason?: unknown } =>
      typeof entry === "object" && entry !== null,
  );
  return first !== undefined && typeof first.reason === "string"
    ? first.reason
    : undefined;
}

/**
 * 官方 HTTP 错误的统一分类阶梯：401 凭据、403 配额/权限、429 限流、5xx 不可用。
 * 各数据模块用自己的错误工厂保持既有错误类型与文案。
 */
export function classifyHttpResponseError(
  status: number,
  payload: unknown,
  factories: HttpErrorFactories,
): Error {
  const reason = extractApiErrorReason(payload);
  if (status === 401) {
    return factories.credential();
  }
  if (status === 403 && /quota/i.test(reason ?? "")) {
    return factories.quota();
  }
  if (status === 403) {
    return factories.permission();
  }
  if (status === 429) {
    return factories.rateLimited();
  }
  if (status >= 500) {
    return factories.serverUnavailable();
  }
  return factories.requestFailed();
}
