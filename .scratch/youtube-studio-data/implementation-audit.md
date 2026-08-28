# 当前仓库主要功能实现审计

审计日期：2026-08-24  
审计范围：基础内容检索、YouTube Studio 只读数据接入/同步/更新、配置与质量验证。  
审计边界：只读检查，不修改 `src/`、`test/` 或运行配置；本文档本身是本次新增的审计记录。

## 结论摘要

仓库的离线实现已经覆盖一条较完整的 CLI 只读链路：公开内容检索、OAuth 频道接入、频道/上传播放列表/视频元数据同步、核心 Analytics、高维细分、异步 Reporting、只读评论、覆盖矩阵和新鲜度读取。`npm run verify` 已通过，当前证据为 16 个测试文件、151 个测试全部通过。

但“主要功能已实现”不能等同于“真实环境已验收”：真实 Google OAuth、真实频道权限、配额、API 历史窗口、Reporting 延迟以及 Windows DPAPI 均未在本次审计中完成人工端到端验证。当前机器上的 `yt-dlp` 入口执行失败（`Access is denied`），OAuth client ID/secret 也未配置，因此基础搜索和真实 Studio API 同步不能判定为线上可用。

最需要优先处理的风险是：`src/lib/oauth.ts:1026-1061` 的当前访问令牌读取路径在令牌过期时直接失败，审计未看到使用 `refreshToken` 调用 Google token endpoint 的续期路径。若该观察在真实运行中成立，约一小时后及后续每日同步会要求重新授权，不能满足持续同步目标。

## 术语与证据范围

本文沿用 [CONTEXT.md](../../CONTEXT.md) 的领域词汇：频道接入、运营数据仓库、源站刷新、同步任务、断点续传、首条链路数据基线、高维细分数据、覆盖矩阵、原始证据和最后可用数据。这里的“完整”仅表示覆盖矩阵中已由官方 API 证实且当前仓库声明支持的能力，不表示逐项镜像 YouTube Studio 网页 UI。

主要对照材料：

- [README.md](../../README.md)：当前 CLI 命令、使用方式和安全边界。
- [docs/architecture.md](../../docs/architecture.md)：CLI-first 架构、适配层边界及未实现范围。
- [.scratch/youtube-studio-data/spec.md](./spec.md)：验收合同、默认回填窗口和非目标。
- [.scratch/youtube-studio-data/map.md](./map.md)：01-10 号交付票据状态及真实账号验收提示。
- [official-api-capability-research.md](./official-api-capability-research.md)：官方 API 能力与资格限制。

## 一、基础内容检索

### 已实现能力

| 能力             | 代码证据                                              | 当前行为                                                                                              | 状态           |
| ---------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------- |
| 关键词搜索入口   | `src/cli.ts:718-731`                                  | `search <query>`，默认 `--limit 10`；CLI 层限制 `--limit` 为 1-50。                                   | 已实现（离线） |
| yt-dlp 搜索执行  | `src/lib/yt-dlp.ts:148-170`                           | 使用 `ytsearch{limit}:{query}`，拒绝空搜索词，跳过媒体下载并输出单个 JSON。                           | 已实现（离线） |
| 结果精简         | `src/lib/yt-dlp.ts:27-36,135-146`                     | 保留 `id/title/url/channel/durationSeconds/viewCount/uploadDate/thumbnail` 八类字段；异常条目被过滤。 | 已实现         |
| 进程安全         | `src/lib/process.ts:16-36`、`src/lib/yt-dlp.ts:38-42` | 通过参数数组、`shell:false` 执行；强制 `YTDLP_IGNORE_CONFIG=1`，不读取 Cookie/OAuth 参数。            | 已实现         |
| 相邻公开内容能力 | `src/lib/yt-dlp.ts:172-215`                           | 支持单视频 `inspect` 和字幕语言查询 `captions list`。                                                 | 已实现         |
| JSON 错误合同    | `src/cli.ts:550-568`                                  | 成功返回 `{ok,data}`，失败返回 `{ok:false,error}`。                                                   | 已实现         |

### 当前边界与缺口

- 搜索只有关键词和数量参数；没有日期、频道、地区、时长、字幕、排序等可验证筛选条件。
- 没有 `pageToken`/页码续取、缓存、历史、去重、数据截至时间或断点；每次搜索都会重新调用 `yt-dlp`。
- 搜索结果只保留精简字段，描述、标签、分类等信息需要另行调用 `inspect`。
- `searchVideos(query, limit)` 的导出函数本身没有复用 CLI 的 1-50 范围校验；直接调用库函数可能构造非法 `ytsearch` 参数。
- JSON 响应仅做 `Record` 类型断言，没有 zod 响应 schema；缺少 `entries` 或形状异常时可能静默得到空结果（`src/lib/yt-dlp.ts:115-124,162-169`）。
- `runYtDlp` 将所有启动异常归并为“找不到 yt-dlp”（`src/lib/yt-dlp.ts:94-101`），权限、执行策略和文件损坏会与未安装混淆。
- 仓库是 CLI-first；没有 React/Vue/Express 或 HTTP API，`media.search` 只是 [docs/architecture.md:69](../../docs/architecture.md:69) 中的未来 MCP 目标。

### 已做验证与未完成验证

- 通过：`npm run build`；`npm test`（16 个测试文件、151 个测试）。
- 通过：空搜索词返回 `USER_INPUT`；`--limit 0/51/nope` 返回范围错误。
- 未通过现场执行：`search`、`inspect`、`captions list` 均因当前 `yt-dlp` 进程返回 `Access is denied` 而以 `EXTERNAL_COMMAND` 失败；`doctor` 同样报告 `yt-dlp` 不可用，而 `ffmpeg/ffprobe` 可用。
- 测试缺口：`test/yt-dlp.test.ts:9-158` 没有覆盖 `searchVideos` 命令构造、真实 JSON entries、分页、排序、过滤或 `search` CLI 集成。

**判断：** 基础检索代码路径已存在，离线输入错误合同可用；公开检索的真实可用性受本机 `yt-dlp` 执行权限阻塞，搜索功能还不具备分页和可复查历史能力。

## 二、YouTube Studio 频道接入与数据同步

### 已实现能力矩阵

| 数据/操作域      | 主要实现                                      | 可观察结果                                                                                                 | 状态                   |
| ---------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------- |
| OAuth 与频道接入 | `src/lib/oauth.ts:117-1026`                   | 授权开始/完成、DPAPI 保护、可访问频道列表、显式选择、接入状态和令牌状态。                                  | 已实现（离线合同）     |
| 基础元数据同步   | `src/lib/inventory.ts:176-380,613-918`        | 频道、上传播放列表、视频分页；同步范围、页令牌/索引、去重、检查点、规范化数据和原始证据。                  | 已实现（离线合同）     |
| 核心 Analytics   | `src/lib/analytics.ts:82-133,544-805,849-995` | 频道/视频事实、默认 365 天和最大 3650 天窗口、`startIndex` 从 1 的分页、权限/空值/部分覆盖状态、证据保存。 | 已实现（离线合同）     |
| 新鲜度读取       | `src/lib/freshness.ts:146`                    | 缓存读取、显式源站刷新、强制最新；刷新失败时可回退最后可用数据，强制最新不回退。                           | 已实现（离线合同）     |
| 高维 Analytics   | `src/lib/breakdowns.ts:99,212,278-399`        | 配置档案校验/保存/查询/读取，按受支持的指标和维度组合请求。                                                | 已实现（离线合同）     |
| 异步 Reporting   | `src/lib/reporting.ts:55-203,544-766`         | 请求 job、等待报告、取得 `downloadUrl`、导入规范化行、原始证据分离、按行键幂等恢复。                       | 已实现（离线合同）     |
| 只读评论         | `src/lib/comments.ts:37-107,230-277,390-509`  | 评论线程分页、检查点、去重和证据；深层回复不强行展开，使用 `repliesAvailable/partial` 表达范围。           | 部分实现（按范围设计） |
| 覆盖矩阵         | `src/lib/coverage.ts:40-171`                  | 输出已支持、部分支持、资格限制、估算/会调整、异步处理中和不可用状态，并关联脱敏证据路径。                  | 已实现                 |

### 同步和更新语义

当前 CLI 以显式命令和状态查询为主：

- `ops channel sync` / `sync-status`：基础元数据同步和检查点状态。
- `analytics-sync` / `analytics-status` / `analytics-query`：核心事实回填和查询。
- `analytics-read --refresh`：尝试源站刷新；普通读取允许带过期标记的最后可用数据。
- `analytics-read --latest`：要求本次完成刷新，否则失败，不使用陈旧回退。
- `analytics-breakdown`：按分析配置档案或临时口径查询高维细分。
- `reporting-sync` / `reporting-status`：异步报告请求、等待、导入和状态查看。
- `comments-sync` / `comments-status`：只读评论同步和断点状态。
- `coverage`：查看覆盖范围、限制、数据截至时间或报告状态与证据入口。

同步任务在设计上保存规范化数据、原始证据和检查点；网络中断、分页、配额、权限不足和异步报告未就绪应表现为可观察状态，而不是静默成功。Analytics 的数据窗口不能被理解为任意历史都可用，Reporting 也不是实时 Studio 卡片接口。

### 关键风险与边界

1. **访问令牌续期待确认（高风险）**：`src/lib/oauth.ts:1026-1061` 当前读取路径只取 `accessToken`，过期后直接报错；本次静态审计未看到用 `refreshToken` 调 Google token endpoint 的续期实现。需要真实授权后验证“过期令牌 -> 自动续期 -> 后续同步”链路，否则每日同步可能在令牌过期后停止。
2. **真实账号和 API 尚未验收**：OAuth client 未配置，未验证频道角色/Brand Account、Analytics 指标历史窗口、配额和 Reporting 延迟。离线伪 provider 通过不代表真实 API 合同已经闭环。
3. **评论范围是部分覆盖**：当前保留顶层线程和可用性标记，不承诺一次同步得到所有深层回复；这符合当前范围，但调用方必须读取 `partial`/覆盖状态。
4. **Reporting CSV 解析边界**：`src/lib/reporting.ts:439-473` 使用手工逐行解析；当前测试未覆盖带嵌入换行的 quoted CSV。此类报告一旦出现多行字段，可能需要补充合同测试或采用成熟 CSV parser。
5. **Reporting 真实 API 合同待核对**：`src/lib/reporting.ts:67-95` 的 job 创建请求需要与官方 `jobs.create` 合同逐字段核对；审计子任务指出当前请求体缺少官方必需的 `name`，并携带日期字段，真实请求可能返回 400。报告列表目前只取单页中第一个带 `downloadUrl` 的结果（`src/lib/reporting.ts:112-141`），未覆盖分页和时间筛选；`waiting` 需要再次运行命令，不会自动轮询（`src/lib/reporting.ts:656-674`）。
6. **Reporting 持续更新和任务隔离待修复**：已导入状态可能直接返回而不检查同一 job 的新日报（`src/lib/reporting.ts:581-590`）；更换 `reportType` 时也可能复用旧 `jobId`，存在跨报告类型读取/导入风险。Reporting 失败状态识别不足时，无 `downloadUrl` 可能长期停留在 `waiting`。
7. **Analytics 结果边界待修复**：合法无数据响应可能不含 `rows`，但解析器强制要求数组，容易被判为 `invalid-response`（`src/lib/analytics.ts:910-924`）。更换日期窗口重跑时继续加载旧 `data.json`，旧窗口行可能残留（`src/lib/analytics.ts:583-620,670-744`）。高维 Analytics 只请求一页，未消费 `nextStartIndex`，超过 200 行可能截断（`src/lib/breakdowns.ts:327-368`）。
8. **OAuth scope 与长期运行待修复**：`estimatedRevenue` 可以进入指标允许列表，但 OAuth scope 白名单未包含 `yt-analytics-monetary.readonly`，收入查询可能因权限失败（`src/lib/oauth.ts:18-38`、`src/lib/breakdowns.ts:23-26`）。访问令牌续期问题见上文第 1 项。
9. **持续调度尚未实现**：`frequencyHours`、`maxConcurrency`、`quotaBudget`、`initialBackfillDays` 等目前主要是配置 schema/持久化字段（`src/lib/config.ts:317-347`），没有 scheduler、定时器、队列或后台 worker；Reporting waiting 也不会自动轮询。当前必须人工重复执行 CLI。
10. **同步状态和并发边界待验证**：部分同步函数把网络/权限/配额失败保存到 `state.error` 后正常返回，CLI 可能仍输出 `ok:true`，调用方必须检查状态字段。Inventory、Analytics、Reporting、Comments 的数据状态写入未发现统一互斥锁，同一频道并发执行可能互相覆盖；配置的证据保留期也未形成统一清理入口。

### 尚未实现或明确不在范围

- 频道写入：上传、发布、标题/简介/隐私/排程修改、删除、创建或回复评论。
- YouTube Studio 网页 UI 逐项镜像、未被官方 API 证实的实时卡片/实验卡片、网页抓取或 Cookie 绕过。
- 直播数据、MCP 适配层、内置 AI 因果分析/运营建议、服务器部署、多用户共享。
- 普通单频道 OAuth 对 content-owner/system-managed 广告或收入报表的完整保证。

## 三、配置、安全与质量门禁

- `src/lib/config.ts` 提供配置初始化、校验和全局/频道/分析配置档案覆盖更新；敏感字段不得进入 JSON、日志、证据或 Git。
- OAuth 令牌和客户端秘密设计为 Windows 用户级 DPAPI 保护；本次未在当前环境完成人工 DPAPI 验证。
- `src/cli.ts` 和 README 明确将频道运营路径限定为只读；源码中的 POST 主要是 OAuth token exchange 和 Reporting job 请求，不代表频道状态写入。
- `package.json` 提供 `build`、`check`、`test`、`verify`；CI 在 Node 22 环境执行 `npm run verify`。仓库未配置 ESLint，质量门禁由 Prettier、TypeScript 检查、构建和 Vitest 组成。

## 四、验证记录

| 检查                | 结果     | 说明                                                                                  |
| ------------------- | -------- | ------------------------------------------------------------------------------------- |
| `npm run build`     | 通过     | TypeScript 构建通过。                                                                 |
| `npm test`          | 通过     | 16 个测试文件、151 个测试；使用离线伪 provider/合同测试。                             |
| `npm run verify`    | 通过     | 格式、类型检查、构建和测试质量门禁通过。                                              |
| CLI 输入边界        | 通过     | 空搜索词、非法 limit 被拒绝；OAuth/同步命令合同由测试覆盖。                           |
| `ops doctor`        | 部分通过 | `ffmpeg/ffprobe` 可用；`yt-dlp` 因 `Access is denied` 不可执行；OAuth client 未配置。 |
| 真实公开搜索        | 未完成   | 受 `yt-dlp` 执行权限阻塞。                                                            |
| 真实 OAuth/API 同步 | 未完成   | 无真实账号授权、频道角色、配额和 API 延迟验收证据。                                   |
| Windows DPAPI       | 未完成   | 仅有离线测试，未完成当前机器人工验证。                                                |

## 五、最终判断与后续优先级

### 当前判断

- **基础内容搜索：部分完成。** CLI 和安全调用边界已实现，离线输入合同通过；真实检索被本机 `yt-dlp` 权限阻塞，且没有分页/筛选/缓存和专门搜索测试。
- **YouTube Studio 只读同步：离线实现基本完成，真实验收未完成。** OAuth、基础同步、核心/高维 Analytics、Reporting、评论、覆盖和新鲜度合同均有代码与测试证据；真实账号、权限、配额、延迟和令牌续期仍是外部验收条件。
- **YouTube Studio 写入：未实现。** 不能把当前仓库描述为可上传、发布或修改频道状态的工具。

### 建议的下一步验证顺序

1. 先修复或确认本机 `yt-dlp.exe` 的执行权限，再重新运行 `doctor`、`search`、`inspect` 和 `captions list`。
2. 配置测试 OAuth client，使用明确的测试频道完成一次最小 `auth-start -> auth-complete -> channel list -> select`，确认 DPAPI 存取和频道角色。
3. 在令牌过期/模拟过期后验证 refresh token 续期，再运行 inventory、Analytics、Reporting 和 comments 的真实只读同步。
4. 记录真实 API 的配额消耗、历史可用窗口、Reporting 生成延迟、部分/不可用状态和数据截至时间。
5. 为 `searchVideos`/CLI search 增加离线伪执行测试；为 Reporting 增加嵌入换行的 quoted CSV 合同测试；在确认持续调度实现后补充重启/定时恢复证据。

本报告没有修改业务代码，也没有执行删除、提交或真实账号授权操作。
