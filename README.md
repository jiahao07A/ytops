# ytops

`ytops` 是一个面向 Windows 本地工作流的 YouTube CLI。它不重写下载、编解码或官方 API，而是把成熟工具包装成可审计、可脚本化的高层命令：

- `yt-dlp`：公开内容检索、元数据、字幕和已获授权媒体下载。
- `FFmpeg` / `ffprobe`：本地媒体探测、抽音频与裁剪。
- 官方 YouTube Data / Analytics API：后续单独接入的频道运营能力。

## 能力与文档边界

当前版本采用 **CLI-first + skills**：CLI 是唯一执行层，负责 JSON、退出码和本地文件工件；skills 负责编排、收集确认和解释结果。MCP 仍是后续的窄适配层，不复制媒体处理逻辑。`ops doctor` 只检查频道运营辅助所需的环境变量和本机工具，不执行 OAuth 授权、官方 API 请求、数据同步或频道发布。

README 只维护已交付 CLI、安装、验证和安全摘要。架构与安全决策见 [docs/architecture.md](docs/architecture.md)，频道运营数据的规划、依赖和状态见 [.scratch/youtube-studio-data/spec.md](.scratch/youtube-studio-data/spec.md)。

## 当前能力

| 命令                                        | 作用                                                     | 外部工具                |
| ------------------------------------------- | -------------------------------------------------------- | ----------------------- |
| `doctor`                                    | 检查必需与可选工具，以及安全默认值                       | `yt-dlp`、FFmpeg 等     |
| `search`                                    | 搜索公开视频并返回精简 JSON                              | `yt-dlp`                |
| `inspect`                                   | 读取单视频元数据，不下载媒体                             | `yt-dlp`                |
| `captions list`                             | 查看人工/自动字幕语言                                    | `yt-dlp`                |
| `captions fetch`                            | 将已获授权的字幕写入指定目录                             | `yt-dlp`                |
| `download video/audio`                      | 下载已获授权的媒体                                       | `yt-dlp` + FFmpeg       |
| `process probe/audio/clip`                  | 探测、抽音频、裁剪本地媒体                               | FFmpeg / ffprobe        |
| `ops doctor`                                | 检查后续官方 OAuth 运营接入的环境，不执行授权或 API 请求 | 可选发布工具 + 环境变量 |
| `config init/validate/explain`              | 初始化、校验和解释本地运营配置                           | 本地 JSON + 配置校验    |
| `config set-global/set-channel/set-profile` | 直接持久化三层配置覆盖；确认由调用方编排                 | 本地 JSON + 原子写入    |

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

| Skill                        | 用途                                         | 明确不做的事                        |
| ---------------------------- | -------------------------------------------- | ----------------------------------- |
| `youtube-research`           | 搜索、检查公开元数据与字幕语言               | 下载、Cookie、OAuth、频道写入       |
| `youtube-authorized-media`   | 为明确获授权内容下载视频、音频或字幕         | 未确认权利的下载、读取浏览器 Cookie |
| `youtube-local-media`        | 探测、抽音频、无损裁剪本地文件               | 修改/删除源文件、任意 FFmpeg 参数   |
| `youtube-channel-operations` | 校验本地配置、检查运营环境并生成运营预览计划 | 伪造上传、评论、隐私或元数据写入    |

每个 skill 都要求通过受控的 `node .\dist\cli.js --json` 子命令执行，并把下载、凭据和频道写操作视为独立的高风险边界。当前频道 skill 只支持本地配置和就绪检查；OAuth、频道数据查询、同步与写入仍属于规划能力。

## 安全与合规边界

- 默认强制 `yt-dlp --ignore-config` 和 `YTDLP_IGNORE_CONFIG=1`，不读取用户级配置，不默认读取浏览器 Cookie。
- 所有外部进程以参数数组启动，不拼接 shell 命令。
- 下载操作要求 `--rights-confirmed`；输出目录由调用者明确提供。
- 频道上传、修改元数据、评论或隐私状态必须走官方 OAuth API，并在写入前展示频道、目标资源、影响范围与预览。当前版本不执行这些操作。
- 不能因为内容属于自己就自动推定平台允许使用任意自动化下载方式。发布前需复核 YouTube Terms of Service 和 YouTube API Developer Policies。
- OAuth refresh token、Cookie、客户端密钥、下载清单都不得进入 Git、日志或 skills 文本。

## 规划入口

受控 job、官方 API 只读数据、发布预览、字幕质检和 MCP 适配层均为后续规划。它们的范围和状态只在 [.scratch/youtube-studio-data/spec.md](.scratch/youtube-studio-data/spec.md) 及其 issues 中维护，避免 README 与规划任务各自漂移。
