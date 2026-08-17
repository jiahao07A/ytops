import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const sensitiveFiles = [
  "client_secret.json",
  "client_secret_example.json",
  "client-secrets.json",
  "credentials.json",
  "token.json",
  "oauth-token.json",
  "oauth_token.json",
  "refresh_token.json",
  "access-token.json",
  "cookie.txt",
  "cookies.txt",
  "sample.cookies.txt",
];

describe("credential ignore rules", () => {
  it.each(sensitiveFiles)("ignores %s", (filename) => {
    const result = spawnSync("git", ["check-ignore", "--no-index", "-q", "--", filename], {
      cwd: process.cwd(),
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });
});
