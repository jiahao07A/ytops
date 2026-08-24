# Channel Operations Boundary

Run `npm run build` separately before the current readiness check from `D:\DEV\3_Projects\LP\MCP`. Call the built CLI directly so stdout contains only the JSON payload:

```powershell
pwsh.exe -NoProfile -Command "rtk node .\dist\cli.js --json ops doctor"
```

Current output reports only local tool availability and whether `YTOPS_GOOGLE_CLIENT_ID` and `YTOPS_GOOGLE_CLIENT_SECRET` are configured. It does not authenticate or save credentials. Read-only OAuth channel connection is a separate `ops channel` workflow.

Before the first `auth-start`, configure Google Cloud: enable YouTube Data API v3, complete the OAuth consent screen, add the real account as a test user when the app is External, create an OAuth client, and register the exact loopback redirect URI used by the CLI. The default is `http://127.0.0.1:8765/oauth2callback`. Do not put client secrets in command arguments, notes, logs, or JSON. The first successful `auth-complete` stores the client secret in the Windows user-scoped DPAPI store; later completions may use that protected value without an environment variable.

Start and complete a read-only connection with the built CLI:

```powershell
pwsh.exe -NoProfile -Command "rtk node .\dist\cli.js --json ops channel auth-start --config .\ytops-config.json"
pwsh.exe -NoProfile -Command "rtk node .\dist\cli.js --json ops channel auth-complete --config .\ytops-config.json --code <callback-code> --state <callback-state>"
pwsh.exe -NoProfile -Command "rtk node .\dist\cli.js --json ops channel list --config .\ytops-config.json"
pwsh.exe -NoProfile -Command "rtk node .\dist\cli.js --json ops channel select --config .\ytops-config.json --channel <channel-id>"
```

The OAuth flow requests `youtube.readonly` by default; add `--analytics` when Analytics or Reporting access is required so the grant also includes `yt-analytics.readonly`. Add `--comments` only when comment list synchronization is explicitly requested; YouTube's comment endpoints use `youtube.force-ssl`, while this CLI still exposes read-only list operations and no comment mutations. Token material is stored through the Windows user-scoped DPAPI store and kept out of configuration, logs, and JSON output. Multiple channels require explicit selection; the CLI never chooses the first result automatically.

After explicit selection, synchronize only the requested metadata scope and keep the returned checkpoint:

```powershell
pwsh.exe -NoProfile -Command "rtk node .\dist\cli.js --json ops channel sync --config .\ytops-config.json --channel <channel-id> --scope channel,uploads,videos"
pwsh.exe -NoProfile -Command "rtk node .\dist\cli.js --json ops channel sync-status --config .\ytops-config.json --channel <channel-id>"
```

The sync command stores normalized channel, upload-playlist and video metadata plus raw evidence; it never stores OAuth tokens in the repository. A failed page remains resumable from the saved checkpoint.

Core Analytics uses the same selected channel and stores normalized channel/video facts, raw evidence and paging state. The default backfill is 365 days and the product limit is 3650 days; the official API may return a smaller effective window or a permission/qualification status. Use `--analytics` during `auth-start` when the OAuth grant must include `yt-analytics.readonly`:

```powershell
pwsh.exe -NoProfile -Command "rtk node .\dist\cli.js --json ops channel auth-start --analytics --config .\ytops-config.json"

pwsh.exe -NoProfile -Command "rtk node .\dist\cli.js --json ops channel auth-start --comments --config .\ytops-config.json"
pwsh.exe -NoProfile -Command "rtk node .\dist\cli.js --json ops channel analytics-sync --config .\ytops-config.json --channel <channel-id>"
pwsh.exe -NoProfile -Command "rtk node .\dist\cli.js --json ops channel analytics-read --config .\ytops-config.json --channel <channel-id> --refresh"
pwsh.exe -NoProfile -Command "rtk node .\dist\cli.js --json ops channel coverage --config .\ytops-config.json --channel <channel-id>"
```

`analytics-read --latest` refuses stale fallback when refresh fails. `analytics-breakdown`, `reporting-sync` and `comments-sync` are read-only and expose qualification, asynchronous, partial and unavailable states instead of converting missing data to zero. Every stored evidence reference excludes OAuth credentials.

Use official user OAuth for private data and channel writes. Do not use a service account for an individual YouTube channel. Before a future write operation, show the channel, target resource, requested change, privacy state, and verification plan, then obtain explicit confirmation.
