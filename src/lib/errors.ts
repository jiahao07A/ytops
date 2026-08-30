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
