# ytops

`ytops` 是一个面向 Windows 本地工作流的 YouTube CLI。它不重写下载、编解码或官方 API，而是把成熟工具包装成可审计、可脚本化的高层命令：

- `yt-dlp`：公开内容检索、元数据、字幕和已获授权媒体下载。
- `FFmpeg` / `ffprobe`：本地媒体探测、抽音频与裁剪。
- 官方 YouTube Data API / Analytics / Reporting：频道 OAuth 接入、只读数据同步和覆盖审计。

## 能力与文档边界

当前版本采用 **CLI-first + skills**：CLI 是唯一执行层，负责 JSON、退出码和本地文件工件；skills 负责编排、收集确认和解释结果。MCP 仍是后续的窄适配层，不复制媒体处理逻辑。`ops doctor` 只检查频道运营辅助所需的环境变量和本机工具；`ops channel` 提供只读 OAuth 接入、频道发现、元数据同步、Analytics、Reporting、评论和覆盖审计，不执行频道写入。

README 只维护已交付 CLI、安装、验证和安全摘要。架构与安全决策见 [docs/architecture.md](docs/architecture.md)，频道运营数据的规划、依赖和状态见 [.scratch/youtube-studio-data/spec.md](.scratch/youtube-studio-data/spec.md)。

## 当前能力

| 命令                                        | 作用                                                 | 外部工具                              |
| ------------------------------------------- | ---------------------------------------------------- | ------------------------------------- |
| `doctor`                                    | 检查必需与可选工具，以及安全默认值                   | `yt-dlp`、FFmpeg 等                   |
| `search`                                    | 搜索公开视频并返回精简 JSON                          | `yt-dlp`                              |
| `inspect`                                   | 读取单视频元数据，不下载媒体                         | `yt-dlp`                              |
| `captions list`                             | 查看人工/自动字幕语言                                | `yt-dlp`                              |
| `captions fetch`                            | 将已获授权的字幕写入指定目录                         | `yt-dlp`                              |
| `download video/audio`                      | 下载已获授权的媒体                                   | `yt-dlp` + FFmpeg                     |
| `process probe/audio/clip`                  | 探测、抽音频、裁剪本地媒体                           | FFmpeg / ffprobe                      |
| `ops doctor`                                | 检查官方 OAuth 运营接入的环境，不执行授权或 API 请求 | 可选发布工具 + 环境变量               |
| `ops channel auth-start/auth-complete`      | 启动并完成只读 OAuth，展示可访问频道，不输出令牌     | 官方 OAuth + YouTube Data API         |
| `ops channel list/status/select`            | 查看接入状态并显式选择目标频道                       | 本机状态 + 受保护凭据                 |
| `ops channel sync/sync-status`              | 同步或查询频道、上传播放列表和视频元数据             | 官方 YouTube Data API + 本机仓库      |
| `ops channel analytics-sync/status/query`   | 回填、查询和检查核心 Analytics 事实                  | 官方 YouTube Analytics API + 本机仓库 |
| `ops channel analytics-read`                | 读取最后可用数据、刷新或强制最新                     | Analytics 新鲜度合同                  |
| `ops channel analytics-breakdown`           | 按临时口径查询高维细分                               | 受校验的 Analytics 配置               |
| `ops channel reporting-sync/status`         | 请求、等待和导入异步 Reporting 报告                  | 官方 Reporting 适配层                 |
| `ops channel comments-sync/status`          | 只读同步评论并查询检查点                             | 官方 YouTube Data API                 |
| `ops channel coverage`                      | 输出覆盖矩阵、限制原因和证据入口                     | 本机仓库审计                          |
| `config init/validate/explain`              | 初始化、校验和解释本地运营配置                       | 本地 JSON + 配置校验                  |
| `config set-global/set-channel/set-profile` | 直接持久化三层配置覆盖；确认由调用方编排             | 本地 JSON + 原子写入                  |

## 快速开始

前提：Node.js 22+、`yt-dlp`、`ffmpeg` 与 `ffprobe` 位于 `PATH`。请先运行 `doctor` 检查当前机器状态。

```powershell
npm install
npm run build
node .\dist\cli.js --json doctor
node .\dist\cli.js --json config explain
node .\dist\cli.js --json config init --output .\ytops-config.json
node .\dist\cli.js --json search "C++11 入门" --limit 5
node .\dist\cli.js --json inspect "https://www.youtube.com/watch?v=VIDEO_ID_11"
node .\dist\cli.js --json captions list "https://www.youtube.com/watch?v=VIDEO_ID_11"
```

频道 OAuth 接入默认只申请 `youtube.readonly`；需要 Analytics/Reporting 时可在 `auth-start` 添加 `--analytics` 申请 `yt-analytics.readonly`；需要评论读取时显式添加 `--comments`（YouTube 官方评论接口使用 `youtube.force-ssl`，本工具仍只执行列表读取）。首次使用前按以下步骤准备 Google Cloud：

1. 在 Google Cloud Console 创建或选择一个项目，并启用 **YouTube Data API v3**。
2. 在 **OAuth consent screen** 中配置应用名称、支持邮箱和开发者联系邮箱；如果应用类型为 External，将实际授权账号加入 **Test users**。
3. 创建 OAuth client。使用本机 CLI 支持的回调地址；默认是 `http://127.0.0.1:8765/oauth2callback`，如果改用其他地址，必须在 Google Cloud 和命令中保持完全一致。
4. 只在本机 PowerShell 环境变量中准备客户端 ID。客户端秘密可以作为首次授权交换的临时输入；成功后会写入 Windows 用户级 DPAPI 保护存储，不进入配置、日志、JSON 或 Git。

```powershell
$env:YTOPS_GOOGLE_CLIENT_ID = "<Google OAuth client id>"
$env:YTOPS_GOOGLE_CLIENT_SECRET = "<Google OAuth client secret>"
```

启动授权并完成回调。不要把授权码、state、客户端秘密或令牌粘贴到聊天、日志或 issue：

```powershell
node .\dist\cli.js --json ops channel auth-start --config .\ytops-config.json
node .\dist\cli.js --json ops channel auth-complete --config .\ytops-config.json --code "<callback code>" --state "<callback state>"
node .\dist\cli.js --json ops channel list --config .\ytops-config.json
node .\dist\cli.js --json ops channel select --config .\ytops-config.json --channel UCXXXXXXXXXXXXXXXXXXXXXX
```

`auth-complete` 会优先使用当前环境中的客户端秘密，并在成功交换后将其保存到操作系统用户范围保护的 DPAPI 存储；后续完成授权时可以不再设置该环境变量。多个可访问频道不会自动选择第一个，必须显式执行 `select`。`status` 会报告未连接、待选择、已连接、令牌过期或 OAuth 验证失败等状态。完成频道选择后，可以显式同步元数据：

```powershell
node .\dist\cli.js --json ops channel sync --config .\ytops-config.json --channel UCXXXXXXXXXXXXXXXXXXXXXX --scope channel,uploads,videos
node .\dist\cli.js --json ops channel sync-status --config .\ytops-config.json --channel UCXXXXXXXXXXXXXXXXXXXXXX
node .\dist\cli.js --json ops channel analytics-sync --config .\ytops-config.json --channel UCXXXXXXXXXXXXXXXXXXXXXX
node .\dist\cli.js --json ops channel analytics-read --config .\ytops-config.json --channel UCXXXXXXXXXXXXXXXXXXXXXX --refresh
node .\dist\cli.js --json ops channel coverage --config .\ytops-config.json --channel UCXXXXXXXXXXXXXXXXXXXXXX
```

同步会保存规范化数据、原始 API 证据和分页检查点。Analytics 默认回填最近 365 天，最多 3650 天；源站失败时普通读取返回带过期标记的最后可用数据，`--latest` 失败则不回退。Reporting、评论和覆盖矩阵均保持只读，任何频道写入仍不在当前范围内。

下载必须显式表明你拥有内容权利或已经得到授权，并提供明确的输出目录：

```powershell
node .\dist\cli.js download video "https://www.youtube.com/watch?v=VIDEO_ID_11" --quality 1080p --output-dir "D:\media\authorized" --rights-confirmed
```

本地处理不会修改原文件：

```powershell
node .\dist\cli.js process audio "D:\media\input.mp4" --output "D:\media\output.m4a" --format m4a
node .\dist\cli.js process clip "D:\media\input.mp4" --start 00:01:05 --end 00:01:25 --output "D:\media\clip.mp4"
```

将 `--json` 放在子命令前，供后续 skills、脚本和 MCP 适配层消费，例如 `node .\dist\cli.js --json doctor`。JSON 调用必须在单独完成 `npm run build` 后直接运行 `node .\dist\cli.js`，不要使用 `npm run start` 包装。

## 开发验证

```powershell
npm run format:check # 只检查格式
npm run check        # TypeScript 类型检查
npm run test         # 构建后运行 Vitest
npm run verify       # 格式、类型检查和测试的完整质量门禁
```

需要自动修正格式时运行 `npm run format`。质量基线由 Prettier、`tsc --noEmit` 和 Vitest 组成；仓库当前未配置 ESLint 或 `typescript-eslint`。详细技能和工程工作流见 [docs/skills/mattpocock-installed-skills.md](docs/skills/mattpocock-installed-skills.md)。

## Codex Skills

可复用的 Codex skills 源码保存在 [skills/](skills/)，并与 CLI 一起接受版本管理和验证；在项目成熟前，它们**不会**安装到 `C:\Users\A2134\.codex\skills` 全局目录。

| Skill                        | 用途                                                | 明确不做的事                        |
| ---------------------------- | --------------------------------------------------- | ----------------------------------- |
| `youtube-research`           | 搜索、检查公开元数据与字幕语言                      | 下载、Cookie、OAuth、频道写入       |
| `youtube-authorized-media`   | 为明确获授权内容下载视频、音频或字幕                | 未确认权利的下载、读取浏览器 Cookie |
| `youtube-local-media`        | 探测、抽音频、无损裁剪本地文件                      | 修改/删除源文件、任意 FFmpeg 参数   |
| `youtube-channel-operations` | 校验本地配置、执行 OAuth 接入准备并生成运营预览计划 | 伪造上传、评论、隐私或元数据写入    |

每个 skill 都要求通过受控的 `node .\dist\cli.js --json` 子命令执行，并把下载、凭据和频道写操作视为独立的高风险边界。当前频道 skill 支持本地配置、只读 OAuth 频道接入、数据同步、Analytics/Reporting/评论查询和覆盖审计；频道写入仍属于禁止范围。

## 安全与合规边界

- 默认强制 `yt-dlp --ignore-config` 和 `YTDLP_IGNORE_CONFIG=1`，不读取用户级配置，不默认读取浏览器 Cookie。
- 所有外部进程以参数数组启动，不拼接 shell 命令。
- 下载操作要求 `--rights-confirmed`；输出目录由调用者明确提供。
- 频道上传、修改元数据、评论或隐私状态必须走官方 OAuth API，并在写入前展示频道、目标资源、影响范围与预览。当前版本不执行这些操作。
- 不能因为内容属于自己就自动推定平台允许使用任意自动化下载方式。发布前需复核 YouTube Terms of Service 和 YouTube API Developer Policies。
- OAuth refresh token、Cookie、客户端密钥、下载清单和原始 API 响应中的凭据字段都不得进入 Git、日志或 JSON 输出。

## 规划入口

受控 job、官方 API 只读数据、发布预览、字幕质检和 MCP 适配层均为后续规划。它们的范围和状态只在 [.scratch/youtube-studio-data/spec.md](.scratch/youtube-studio-data/spec.md) 及其 issues 中维护，避免 README 与规划任务各自漂移。
