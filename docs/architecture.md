# ytops Architecture

## Decision

选择 **CLI-first + skills + optional MCP**。

`CLI + skills` 是主方案：长下载、转码、批量作业、可复现输出、Windows 路径和失败重试都属于命令行的自然边界。`MCP + skills` 不是替代方案，而是后续给 Agent/IDE 暴露稳定任务入口的薄适配层。

| 维度           | CLI + skills                   | MCP + skills                   | 本项目决定                           |
| -------------- | ------------------------------ | ------------------------------ | ------------------------------------ |
| 长任务与大文件 | 原生进度、取消、日志和落盘工件 | 易碰到超时与上下文体积         | CLI 负责执行                         |
| 自动工具发现   | 依赖 skill 描述和 `--help`     | JSON Schema 对 Agent 更友好    | MCP 后置接入                         |
| 可测试性       | JSON、退出码、fixture 易稳定   | 还要维护 JSON-RPC 与 host 兼容 | CLI 为唯一事实源                     |
| 权限控制       | 输出目录、权利确认和安全参数   | 注解不能替代实际授权           | CLI 负责约束，skill 在调用前征求确认 |
| 跨客户端调用   | 需要 shell                     | Codex/IDE/Agent 统一           | 用窄 MCP 复用 CLI                    |

## Layers

```text
skills
  -> ytops CLI
       -> yt-dlp                 public discovery, metadata, captions, authorized download
       -> FFmpeg / ffprobe       local media recipes
       -> YouTube Data API       channel and publishing operations
       -> YouTube Analytics API  reporting
       -> local config contract  JSON validation, atomic writes, protected-key checks
       -> optional tools         seconv, whisper.cpp, youtubeuploader
  -> optional MCP adapter
       -> job submit/status/result, not raw flags or binary streams
```

当前实现包含媒体发现、字幕、授权媒体、本地媒体处理、配置管理、`ops doctor` 就绪检查、只读 OAuth 频道接入、可恢复频道元数据同步、核心/高维 Analytics、异步 Reporting、只读评论和覆盖矩阵。OAuth 令牌与客户端秘密由 Windows 用户级 DPAPI 保护；状态查询可以使用官方 API 校验凭据并报告过期、失效或撤销原因。频道写入和 MCP 适配层仍未实现；上图中这些路径是目标边界，不是当前 CLI 能力。

`config set-global`、`config set-channel` 和 `config set-profile` 在 CLI 被调用时会直接写入配置。CLI 没有 `--dry-run` 或 `--apply` 选项；调用方 skill 可以在调用前展示差异并征求确认，但这属于编排层行为。

## Dependency policy

| Component                | Role                                    | Policy                                                                      |
| ------------------------ | --------------------------------------- | --------------------------------------------------------------------------- |
| `yt-dlp`                 | Discovery, metadata, captions, download | Required external executable; do not reimplement extractor logic            |
| `ffmpeg` / `ffprobe`     | Media recipes and probing               | Required external executable; only named high-level recipes                 |
| `commander`              | CLI grammar                             | NPM dependency                                                              |
| `execa`                  | Safe child-process invocation           | NPM dependency; argument arrays only                                        |
| `zod`                    | Boundary validation                     | NPM dependency                                                              |
| `proper-lockfile`        | Cross-process config updates            | NPM dependency; lock before read-modify-write                               |
| `i18n-iso-countries`     | Assigned ISO country filter validation  | NPM dependency; reject unassigned country codes                             |
| `youtubeuploader`        | Optional upload adapter                 | Do not enable until OAuth token storage and private-video smoke tests exist |
| `seconv` / `whisper.cpp` | Optional subtitle processing            | Add only after doctor checks and deterministic recipe tests                 |
| `@kevinwatt/yt-dlp-mcp`  | POC reference only                      | Do not directly depend on `0.10.0` without a security patch                 |

## Security and policy boundary

The media-acquisition side and official channel-operations side are separate products paths:

```text
public / authorized media workflow
  -> yt-dlp, cookies only by explicit opt-in (flags > env > global.cookies, mutually exclusive sources), explicit right confirmation

official channel workflow
  -> user OAuth, least scopes, preview + explicit write confirmation
```

Cookie access is disabled by default (ADR 0001). It is enabled only through explicit opt-in sources, and cookie file contents never enter configs, logs, or JSON output; the config stores at most the local file path. Official channel operations never use browser cookies or `yt-dlp` as an impersonation mechanism.

Do not present `yt-dlp` as an official YouTube API client. The YouTube API developer policies restrict scraping and downloading/caching audiovisual content through an API client. Official channel mutation must use official OAuth APIs; it must not use browser cookies or `yt-dlp` as an impersonation mechanism.

## MCP contract, after the CLI is stable

The MCP layer may expose only bounded tools such as:

- `media.search`
- `media.inspect`
- `media.caption_languages`
- `job.submit_authorized_download`
- `job.status`
- `channel.inventory`
- `analytics.report`
- `publish.preview`

It must not expose arbitrary commands, arbitrary local paths, raw cookies/tokens, complete large transcripts, binary media streams, or delete operations. Download, upload and metadata changes need explicit confirmation in the calling workflow even if an MCP client offers a confirmation annotation.

## Research sources

- [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- [FFmpeg documentation](https://ffmpeg.org/documentation.html)
- [YouTube Data API authentication](https://developers.google.com/youtube/v3/guides/authentication)
- [YouTube Analytics API](https://developers.google.com/youtube/analytics)
- [YouTube API Developer Policies](https://developers.google.com/youtube/terms/developer-policies)
- [Model Context Protocol tools specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- [@kevinwatt/yt-dlp-mcp](https://github.com/kevinwatt/yt-dlp-mcp)
- [youtubeuploader](https://github.com/porjo/youtubeuploader)
- [Subtitle Edit command line](https://github.com/SubtitleEdit/subtitleedit/blob/main/docs/reference/command-line.md)
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
