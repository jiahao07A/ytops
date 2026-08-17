---
name: youtube-channel-operations
description: 评估官方 YouTube 频道运营的准备情况，并围绕仓库内 ytops CLI 制定受控的发布或分析计划。用户询问 OAuth 配置、频道清单、Analytics 报告、上传准备、标题或简介更新、发布排期、评论或其他频道运营时使用。不要执行未实现的写入、访问浏览器 Cookie，或把 yt-dlp 当作官方 YouTube API 客户端。
---

# YouTube Channel Operations

Use this skill to prepare verified, least-privilege channel work. The current `ytops` MVP exposes readiness checks only; it does not upload, edit, comment, change privacy, or query private channel data. Do not claim that a planned action has been executed.

## Command Contract

Work from `D:\DEV\3_Projects\LP\MCP`. Read [references/operations-boundary.md](references/operations-boundary.md) before work.

## Workflow

1. Identify whether the request is read-only analysis, a publishing plan, or a channel write. Record the target channel, affected resource, desired privacy state, schedule, and expected scope.
2. Run `rtk node .\dist\cli.js --json ops doctor` to inspect whether the OAuth client environment is configured. Do not print or ask for client secrets or refresh tokens in chat.
3. For requests without a matching implemented CLI command, produce a preview plan containing target assets, metadata fields, privacy state, required OAuth scopes, confirmation points, and verification criteria.
4. For future write-capable commands, require an explicit final confirmation after showing the exact target, diff, and impact. Batch writes require the same per-batch summary.
5. State that uploads and private analytics require official YouTube OAuth/API access; do not substitute `yt-dlp`, browser Cookies, or service accounts for individual-channel operations.

## Boundaries

- Never perform or simulate a write operation that the CLI does not implement.
- Never create, expose, commit, log, or copy OAuth client secrets, refresh tokens, browser Cookies, or resumable-upload session URLs.
- Do not request broad scopes when a narrower scope is enough. Treat uploads, metadata changes, comments, and privacy changes as high-impact actions.
- Keep the authorized media workflow separate from official OAuth operations to preserve the platform and compliance boundary.
