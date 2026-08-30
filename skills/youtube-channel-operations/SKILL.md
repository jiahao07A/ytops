---
name: youtube-channel-operations
description: 评估官方 YouTube 频道运营的准备情况，并围绕仓库内 ytops CLI 制定受控的发布或分析计划。用户询问 OAuth 配置、频道清单、Analytics 报告、上传准备、标题或简介更新、发布排期、评论或其他频道运营时使用。不要执行未实现的写入、访问浏览器 Cookie，或把 yt-dlp 当作官方 YouTube API 客户端。
---

# YouTube Channel Operations

Use this skill to prepare verified, least-privilege channel work. The current `ytops` MVP supports local configuration management (`config init`、`validate`、`explain` 和 `set-*`), read-only OAuth channel connection, explicit metadata synchronization, core and breakdown Analytics, asynchronous Reporting status/import, read-only comments, and coverage auditing; it does not upload, edit, reply, or change privacy. Do not claim that a planned action has been executed.

## Command Contract

Work from `D:\DEV\3_Projects\LP\MCP`. Read [references/operations-boundary.md](references/operations-boundary.md) before work.
For configuration intent routing and confirmation rules, also read [references/configuration-assistant.md](references/configuration-assistant.md).

## Workflow

1. Identify whether the request is local configuration, read-only analysis, a publishing plan, or a channel write. Record the target channel, affected resource, desired privacy state, schedule, and expected scope.
2. For a supplied local configuration path, run `rtk node .\dist\cli.js --json config validate --config <path>` first. Use `config explain` to clarify supported values; present the proposed `set-global`、`set-channel` 或 `set-profile` change before any local write, then request confirmation.
3. Before the first authorization, guide the user through Google Cloud project creation, enabling YouTube Data API v3 and YouTube Analytics API, OAuth consent screen configuration, test users for External apps, OAuth client creation, and exact loopback redirect URI registration. Add `--analytics` to `auth-start` only when Analytics/Reporting access is needed. Run `rtk node .\dist\cli.js --json ops doctor` to inspect local readiness. Do not print or ask for client secrets or refresh tokens in chat.
4. To start a read-only connection, run `rtk node .\dist\cli.js --json ops channel auth-start --config <path>`, open the returned authorization URL, and complete the callback with `ops channel auth-complete`. The first completion may read `YTOPS_GOOGLE_CLIENT_SECRET` from the current process and then stores it in the Windows user-scoped DPAPI store; later completions can reuse that protected value. The CLI lists every accessible channel and never selects the first one automatically.
5. Run `ops channel list` or `ops channel status` to inspect the connection state, then use `ops channel select --channel <channel-id>` only after the user explicitly names the target channel.
6. For requests without a matching implemented CLI command, produce a preview plan containing target assets, metadata fields, privacy state, required OAuth scopes, confirmation points, and verification criteria.
7. For future write-capable commands, require an explicit final confirmation after showing the exact target, diff, and impact. Batch writes require the same per-batch summary.
8. For an explicitly selected channel, metadata synchronization is available through `ops channel sync --channel <id> [--scope channel,uploads,videos]`; core Analytics through `analytics-sync`/`analytics-read`; high-dimensional queries through `analytics-breakdown`; per-video full-history retention curves through `retention-sync`/`retention-status`/`retention-read`; async reports through `reporting-sync`; read-only comments through `comments-sync`; and the final coverage contract through `coverage`. Report checkpoints, data-as-of, freshness, coverage and evidence paths. Do not substitute `yt-dlp`, browser Cookies, or service accounts for individual-channel operations.

## Boundaries

- Never perform or simulate a write operation that the CLI does not implement.
- Never create, expose, commit, log, or copy OAuth client secrets, refresh tokens, browser Cookies, or resumable-upload session URLs.
- Do not request broad scopes when a narrower scope is enough. Treat uploads, metadata changes, comments, and privacy changes as high-impact actions.
- Keep the authorized media workflow separate from official OAuth operations to preserve the platform and compliance boundary. Public-retrieval cookie opt-in (`--cookies` / `--cookies-from-browser`) belongs to the media acquisition path only; channel configuration and official API operations in this skill never use browser cookies or `yt-dlp` impersonation.
