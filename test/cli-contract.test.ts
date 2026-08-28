import { describe, expect, it } from "vitest";
import {
  externalToolErrorCode,
  inventorySyncFailure,
  oauthRefreshFailure,
} from "../src/lib/cli-contract.js";
import { OAuthTokenRefreshError } from "../src/lib/oauth.js";
import type { SyncTaskProjection } from "../src/lib/sync-task.js";

function task(status: SyncTaskProjection["status"]): SyncTaskProjection {
  return {
    id: "youtube-data-api:UC123:channel,uploads,videos",
    identity: {
      id: "youtube-data-api:UC123:channel,uploads,videos",
      channelConnectionId: "UC123",
      source: "youtube-data-api",
      scope: ["channel", "uploads", "videos"],
    },
    status,
    updatedAt: "2026-08-27T00:00:00.000Z",
    retryable: false,
    ...(status === "failed"
      ? {
          error: {
            kind: "permission",
            message: "The inventory sync was denied.",
            retryable: false,
          },
        }
      : {}),
  };
}

describe("CLI contract mappings", () => {
  it.each([
    ["missing", "EXTERNAL_TOOL_NOT_FOUND"],
    ["permission-denied", "EXTERNAL_TOOL_PERMISSION_DENIED"],
    ["unlaunchable", "EXTERNAL_TOOL_UNLAUNCHABLE"],
    ["non-zero-exit", "EXTERNAL_COMMAND_FAILED"],
    ["malformed-output", "EXTERNAL_RESPONSE_MALFORMED"],
    ["invalid-output", "EXTERNAL_RESPONSE_INVALID"],
  ] as const)("maps external tool failure %s", (kind, expectedCode) => {
    expect(externalToolErrorCode(kind)).toBe(expectedCode);
  });

  it("returns a structured failure for a terminal inventory task", () => {
    const failedTask = task("failed");

    expect(inventorySyncFailure({ task: failedTask })).toEqual({
      code: "INVENTORY_SYNC_FAILED",
      message: "The inventory sync was denied.",
      details: { task: failedTask },
    });
  });

  it.each(["queued", "running", "waiting", "retrying", "partial", "completed"])(
    "keeps %s inventory tasks on the success path",
    (status) => {
      expect(
        inventorySyncFailure({
          task: task(status as SyncTaskProjection["status"]),
        }),
      ).toBeUndefined();
    },
  );

  it("keeps OAuth refresh classification machine-readable", () => {
    const error = new OAuthTokenRefreshError(
      "Google OAuth is temporarily unavailable.",
      "network",
      true,
    );

    expect(oauthRefreshFailure(error)).toEqual({
      code: "OAUTH_SERVICE",
      message: "Google OAuth is temporarily unavailable.",
      kind: "network",
      retryable: true,
    });
  });
});
