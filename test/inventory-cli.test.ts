import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeChannelOperationsConfig } from "../src/lib/config.js";

const CHANNEL_ID = "UC1111111111111111111111";
const CONNECTION_ID = "inventory-cli-connection";
const DEFAULT_SCOPE = { channel: true, uploads: true, videos: true };
const CHANNEL_SCOPE = { channel: true, uploads: false, videos: false };

function runCli(args: string[]) {
  return spawnSync(
    process.execPath,
    [resolve(process.cwd(), "dist", "cli.js"), ...args],
    { encoding: "utf8" },
  );
}

function state(
  scope: typeof DEFAULT_SCOPE,
  status: "completed" | "failed" = "completed",
) {
  return {
    version: 2,
    channelId: CHANNEL_ID,
    channelConnectionId: CONNECTION_ID,
    status,
    scope,
    phase: status === "completed" ? "complete" : "uploads",
    progress: { pages: 2, items: 2, videoItems: 1 },
    checkpoint: { videoIndex: 1, videoIds: ["VIDEO000001"] },
    startedAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:01:00.000Z",
    ...(status === "completed"
      ? {
          lastSuccessAt: "2026-08-27T00:01:00.000Z",
          dataAsOf: "2026-08-27T00:01:00.000Z",
        }
      : {
          error: {
            kind: "permission",
            message: "The inventory sync was denied.",
            retryable: false,
          },
        }),
  };
}

function data(title: string) {
  return {
    version: 1,
    channelId: CHANNEL_ID,
    source: "youtube-data-api",
    channel: {
      id: CHANNEL_ID,
      title,
      fetchedAt: "2026-08-27T00:01:00.000Z",
    },
    uploads: [],
    videos: [],
    updatedAt: "2026-08-27T00:01:00.000Z",
    dataAsOf: "2026-08-27T00:01:00.000Z",
  };
}

describe("inventory CLI task contract", () => {
  let root: string;
  let configPath: string;
  let inventoryRoot: string;
  let defaultTaskRoot: string;
  let channelTaskRoot: string;
  let files: string[];
  let directories: string[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "ytops-inventory-cli-"));
    configPath = join(root, "config.json");
    inventoryRoot = join(root, ".ytops-data", "inventory", CHANNEL_ID);
    const connectionRoot = join(
      inventoryRoot,
      "connections",
      encodeURIComponent(CONNECTION_ID),
      "tasks",
      "youtube-data-api",
    );
    defaultTaskRoot = join(connectionRoot, "channel+uploads+videos");
    channelTaskRoot = join(connectionRoot, "channel");
    files = [configPath];
    directories = [
      channelTaskRoot,
      defaultTaskRoot,
      connectionRoot,
      join(
        inventoryRoot,
        "connections",
        encodeURIComponent(CONNECTION_ID),
        "tasks",
      ),
      join(inventoryRoot, "connections", encodeURIComponent(CONNECTION_ID)),
      join(inventoryRoot, "connections"),
      inventoryRoot,
      join(root, ".ytops-data", "inventory"),
      join(root, ".ytops-data", "oauth"),
      join(root, ".ytops-data"),
      root,
    ];

    await initializeChannelOperationsConfig(configPath, false);
    const oauthStatePath = join(
      root,
      ".ytops-data",
      "oauth",
      "connections.json",
    );
    mkdirSync(join(root, ".ytops-data", "oauth"), { recursive: true });
    writeFileSync(
      oauthStatePath,
      `${JSON.stringify(
        {
          version: 1,
          availableChannels: [],
          selectedChannelId: CHANNEL_ID,
          connections: [
            {
              connectionId: CONNECTION_ID,
              channelId: CHANNEL_ID,
              title: "Inventory CLI channel",
              status: "connected",
              credentialRef: "inventory-cli-credential",
              scopes: [],
              connectedAt: "2026-08-27T00:00:00.000Z",
              updatedAt: "2026-08-27T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    files.push(oauthStatePath);
  });

  afterEach(() => {
    for (const file of files) {
      if (existsSync(file)) {
        unlinkSync(file);
      }
    }
    for (const directory of directories) {
      if (existsSync(directory)) {
        rmdirSync(directory);
      }
    }
  });

  function writeTask(
    taskRoot: string,
    scope: typeof DEFAULT_SCOPE,
    title: string,
    status: "completed" | "failed" = "completed",
  ): void {
    mkdirSync(taskRoot, { recursive: true });
    const statePath = join(taskRoot, "sync-state.json");
    const dataPath = join(taskRoot, "data.json");
    writeFileSync(
      statePath,
      `${JSON.stringify(state(scope, status), null, 2)}\n`,
    );
    writeFileSync(dataPath, `${JSON.stringify(data(title), null, 2)}\n`);
    files.push(statePath, dataPath);
  }

  it("keeps default and explicit scopes isolated", () => {
    writeTask(defaultTaskRoot, DEFAULT_SCOPE, "Default task channel");
    writeTask(channelTaskRoot, CHANNEL_SCOPE, "Channel-only task");

    const defaultResult = runCli([
      "--json",
      "ops",
      "channel",
      "sync-status",
      "--config",
      configPath,
      "--channel",
      CHANNEL_ID,
    ]);
    const scopedResult = runCli([
      "--json",
      "ops",
      "channel",
      "sync-status",
      "--config",
      configPath,
      "--channel",
      CHANNEL_ID,
      "--scope",
      "channel",
    ]);

    expect(defaultResult.status).toBe(0);
    expect(scopedResult.status).toBe(0);
    expect(JSON.parse(defaultResult.stdout)).toMatchObject({
      ok: true,
      data: {
        task: { identity: { scope: ["channel", "uploads", "videos"] } },
        data: { channel: { title: "Default task channel" } },
      },
    });
    expect(JSON.parse(scopedResult.stdout)).toMatchObject({
      ok: true,
      data: {
        task: { identity: { scope: ["channel"] } },
        data: { channel: { title: "Channel-only task" } },
      },
    });
  });

  it("reports a stored terminal failure as status data", () => {
    writeTask(defaultTaskRoot, DEFAULT_SCOPE, "Last available data", "failed");

    const result = runCli([
      "--json",
      "ops",
      "channel",
      "sync-status",
      "--config",
      configPath,
      "--channel",
      CHANNEL_ID,
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: {
        task: {
          status: "failed",
          retryable: false,
          error: { kind: "permission", retryable: false },
        },
      },
    });
  });

  it("rejects a videos-only scope", () => {
    const result = runCli([
      "--json",
      "ops",
      "channel",
      "sync-status",
      "--config",
      configPath,
      "--channel",
      CHANNEL_ID,
      "--scope",
      "videos",
    ]);

    expect(result.status).toBeGreaterThan(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "USER_INPUT" },
    });
  });
});
