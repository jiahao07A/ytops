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

export class InventoryServiceError extends Error {
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

export class AnalyticsServiceError extends Error {
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

export class ReportingServiceError extends Error {
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

export class CommentsServiceError extends Error {
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

export type RetentionFailureKind =
  | "quota"
  | "network"
  | "permission"
  | "invalid-response"
  | "credential"
  | "not-ready";

export class RetentionServiceError extends Error {
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
