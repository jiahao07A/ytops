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
pwsh.exe -NoProfile -Command "rtk node .\dist\cli.js --json ops channel retention-sync --config .\ytops-config.json --channel <channel-id>"
pwsh.exe -NoProfile -Command "rtk node .\dist\cli.js --json ops channel retention-status --config .\ytops-config.json --channel <channel-id>"
pwsh.exe -NoProfile -Command "rtk node .\dist\cli.js --json ops channel retention-read --config .\ytops-config.json --channel <channel-id> --video <video-id> --refresh"
pwsh.exe -NoProfile -Command "rtk node .\dist\cli.js --json ops channel coverage --config .\ytops-config.json --channel <channel-id>"
```

`analytics-read --latest` refuses stale fallback when refresh fails. `analytics-breakdown`, `reporting-sync` and `comments-sync` are read-only and expose qualification, asynchronous, partial and unavailable states instead of converting missing data to zero. Reporting data is stored per report type under the operations data directory, so syncing a new report type never overwrites an existing one; `reporting-status` can query a specific report type or list every report type that already has a stored state. Every stored evidence reference excludes OAuth credentials. `analytics-read --derived` derives RPM (estimated revenue per thousand engaged views, ADR 0002) and the like/dislike ratio at read time only; the warehouse keeps raw values and nothing derived is persisted.

Revenue metrics (`estimatedRevenue`) stay gated behind an explicit opt-in (ADR 0003): enable it with `ytops config set-global --analytics-revenue-opt-in true` (or `--channel-analytics-revenue-opt-in` for one channel), then re-authenticate with `auth-start --analytics --analytics-revenue` so the grant includes `yt-analytics-monetary.readonly`. Opted-in core syncs request revenue with an explicit `currency=USD`; audience breakdown groups never carry revenue metrics. Without the opt-in the scope is never requested, revenue queries are rejected locally, and the coverage matrix reports `analytics.revenue` as qualification-limited instead of faking zeros. Official documentation is contradictory about channel-level revenue availability: run a real-channel probe (opt-in, re-auth, one `analytics-sync`, inspect `evidence/`) and record the outcome before promising channel-level revenue behavior. `ops doctor --config <path>` reports only the opt-in status, never config values.

Reach and click-through rate data is the official bulk report `channel_reach_basic_a1`, the registered reach report type for `reporting-sync`/`reporting-status`/`reporting-read`. It needs no scope beyond `yt-analytics.readonly`. Rows are one per date, channel and video, carrying `video_thumbnail_impressions` and `video_thumbnail_impressions_ctr`:

```powershell
pwsh.exe -NoProfile -Command "rtk node .\dist\cli.js --json ops channel reporting-sync --config .\ytops-config.json --channel <channel-id> --report-type channel_reach_basic_a1"
pwsh.exe -NoProfile -Command "rtk node .\dist\cli.js --json ops channel reporting-status --config .\ytops-config.json --channel <channel-id> --report-type channel_reach_basic_a1"
pwsh.exe -NoProfile -Command "rtk node .\dist\cli.js --json ops channel reporting-read --config .\ytops-config.json --channel <channel-id> --report-type channel_reach_basic_a1 --video <video-id>"
```

`reporting-read` returns the stored rows plus the data-as-of timestamp; reach rows are normalized to `date`/`channelId`/`videoId`/`impressions`/`ctr`, while other report types pass their stored rows through unchanged. CSV values are kept verbatim: the CTR column may be a decimal or a percentage and is never re-computed, and cells suppressed by the privacy threshold stay empty instead of becoming zero. Registered impressions only cover the reach YouTube can attribute, so impressions and CTR are a subset of total reach.

Official bulk reports can be downloaded for roughly 60 days after generation, and historical reports for roughly 30 days; deleted reports cannot be re-fetched. Schedule `reporting-sync` for the reach report at least every 30 days (for example weekly), or long-term daily impressions and CTR data will have permanent gaps.

Retention curves are the official single-video `audienceWatchRatio` metric across the `elapsedVideoTimeRatio` dimension: one query per video, roughly 100 fixed ratio points, and no channel-level curve exists. `retention-sync` queries each inventory video with a fixed earliest start date (2005-07-14); the official response defines the actual covered window, so no date-range flag is offered. The first run builds curves for every inventory video with a resumable per-video checkpoint; later runs only fetch newly discovered videos. Curved values above 100% (repeat or overlapping plays) are reported verbatim, and cells suppressed by the privacy threshold are omitted instead of being written as zero. `retention-read` returns one video's full-history curve from the last available data; `--refresh` falls back to stored data on failure, while `--latest` fails rather than returning stale curves.

Use official user OAuth for private data and channel writes. Do not use a service account for an individual YouTube channel. Before a future write operation, show the channel, target resource, requested change, privacy state, and verification plan, then obtain explicit confirmation.
