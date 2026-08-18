# YouTube Studio 频道运营数据官方 API 能力研究

Type: research
Status: resolved
Source: 2026-08-17 delegated primary-source research and Context7

## 研究问题

“完整获得 Studio 的所有数据”不能直接作为 API 需求。YouTube Studio 的展示面由多个官方 API、权限层级和非公开产品能力组成；本条目先划定单个频道 OAuth 接入的可达范围，再列出不能承诺的部分。

本研究使用 Context7 官方文档库 `/websites/developers_google_youtube_v3`、`/websites/developers_google_youtube`，并回溯到 Google/YouTube 官方文档和帮助中心链接。没有使用第三方 SDK、网页抓取或浏览器 Cookie 作为事实来源。

## 结论总表

| 能力面                   | 状态                             | 可确认结论                                                                                                                                                                                                                                                    | 设计含义                                                                                                   |
| ------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 单频道用户 OAuth 身份    | 已证实                           | 私有频道数据必须使用用户 OAuth 2.0；YouTube Data API 不支持 service account，使用时可能返回 `NoLinkedYouTubeAccount`。                                                                                                                                        | 接入必须绑定 Google 用户授权和明确的目标 channel ID；不能把 service account 当作频道账号。                 |
| 频道、视频、播放列表清单 | 已证实                           | `channels.list(mine=true)` 返回当前授权用户拥有的频道；频道的 `contentDetails.relatedPlaylists.uploads` 可继续用 `playlistItems.list` 分页取得上传视频。                                                                                                      | `mine=true` 可能返回多个频道，不能假设一个 Google 用户只有一个频道。                                       |
| 视频私有字段             | 已证实但受权限限制               | `fileDetails`、`processingDetails`、`suggestions` 等 owner-only 字段并非公开 API key 可得；`dislikeCount` 也受 owner 授权限制。                                                                                                                               | 数据模型必须区分公开字段、授权字段和不可用字段。                                                           |
| 评论与审核               | 已证实但需要高权限               | `commentThreads.list`/`comments.list` 可取评论和回复；线程响应中的 replies 可能只是子集，完整回复要按 `parentId` 继续调用 `comments.list`。审核状态需要 proper authorization；Discovery 文档列出 `youtube.force-ssl` 范围。                                   | “评论总量/完整回复/待审核”必须是可验证的分页作业，不能只抓首个线程响应。                                   |
| 直播与 Live Chat         | 部分可用                         | `liveBroadcasts`、`liveStreams`、`liveChatMessages` 有官方接口；Live Chat 首次响应只覆盖当前可取得的最新部分，不能承诺首次接入前的历史聊天完整回填。                                                                                                          | 直播聊天应单独标注“从接入点开始捕获”，用 `streamList` 或轮询状态保存断点。                                 |
| Analytics 定向报表       | 已证实                           | `reports.query` 以 channel/content owner、起止日期、metrics 为核心，支持 dimensions、filters、sort；频道可使用 `channel==CHANNEL_ID` 或授权的 `channel==MINE`。                                                                                               | 报表请求必须记录完整查询条件，指标和维度组合需要能力矩阵校验。                                             |
| Analytics 指标/维度      | 部分已证实                       | 官方维度目录覆盖资源、日期、国家、播放位置、流量来源、设备、人口统计、留存、直播和广告等类别；核心维度包括 `ageGroup`、`channel`、`country`、`day`、`gender`、`month`、`sharingService`、`uploaderType`、`video`。                                            | “全部指标”不是任意笛卡尔积；每个 report type 要保存允许的 metrics/dimensions 组合。                        |
| 收入                     | 部分可用                         | Analytics 的 `estimatedRevenue` 是估算净收入，月末可能调整；不等同于最终结算，也不覆盖所有 partner-sold/partner-served 广告。货币指标需要 `yt-analytics-monetary.readonly`。Reporting 的 system-managed 广告收入报表只面向有相应权限的 content owner。        | 收入字段必须标明 `estimated`、币种、查询日和调整风险；普通单频道账号不能承诺拿到 content-owner 报表。      |
| 受众/人口统计            | 部分可用                         | Analytics 文档有 `ageGroup`、`gender` 等维度，但报告组合和隐私阈值会影响行是否出现；Reporting 低隐私阈值数据可能匿名或为空。                                                                                                                                  | 空值与零值必须区分；不能把 Studio 显示的每个受众卡片都映射成稳定 API 字段。                                |
| 实时数据                 | 未证实为 Studio 实时卡片         | 官方把 Analytics 描述为“targeted, real-time queries”，这里的 real-time 是同步定向查询方式；文档没有证明它等于 Studio 的 Realtime 卡片，也没有覆盖所有 UI 卡片的接口。                                                                                         | 产品文案不能承诺“完整实时 Studio”；实时卡片应单独标为待验证/不可用，直到针对具体指标找到官方 endpoint。    |
| Analytics 历史窗口与延迟 | 未证实为统一固定值               | `reports.query` 接受 `startDate`/`endDate`，但没有一个适用于所有指标和报告的统一最长历史窗口或刷新 SLA。                                                                                                                                                      | 不能在规格中写死“任意历史都可查”或固定分钟级延迟；首次同步前应按指标和日期做实测并记录。                   |
| Reporting 批量报表       | 已证实但不是实时接口             | Reporting 通过 job 生成预定义 CSV，每个报告按约 24 小时周期生成；报告有有限保留期，文档/报告类型存在约 30–60 天的可取窗口，旧报告会删除，回填可能替换已有数据。                                                                                               | Reporting 适合作为每日落盘的补充源，不能替代长期本地历史仓库；同步必须保存 report ID、生成时间和下载校验。 |
| 分页                     | 已证实                           | Data API 列表使用 `pageToken`/`nextPageToken` 和 `maxResults`；Analytics 使用 `maxResults`/`startIndex`；Reporting 使用 jobs/reports 列表再下载生成文件。                                                                                                     | 每个资源范围都要有断点、页令牌、请求时间和失败重试记录。                                                   |
| 配额                     | 已证实存在，部分数值需运行前确认 | Data API 每次请求（包括无效请求）至少消耗 1 quota point，分页请求分别计费；默认项目配额文档列出每日 10,000 units，并对 `search.list`/上传等方法有专门限制。Analytics API 文档确认每个 API request 计一个 quota unit，具体项目额度在 Google API Console 查看。 | 配额预算、退避、分页和日界线（Pacific Time）必须是一等状态；不要仅按 HTTP 成功判断同步完成。               |
| Studio 额外产品能力      | 未证实或不可用                   | 官方 API 文档没有给出“Studio 全部 UI 卡片一一对应 API”的承诺。频道权限迁移到 Studio channel permissions 后，YouTube Help 明确受邀管理者不能通过 YouTube APIs 管理；content-owner、audit、system-managed 报表也有专门身份边界。                                | 必须先建立“API 可用/需 content owner/仅 Studio/未发现官方接口”的覆盖矩阵，不能以网页抓取补齐缺口。         |

## 已证实的官方边界

### 1. OAuth 身份和最小范围

- [YouTube Data API authentication](https://developers.google.com/youtube/v3/guides/authentication) 规定 OAuth 2.0 用于私有用户数据；官方不支持 service account。桌面应用可以使用浏览器授权和 localhost loopback 回调，见 [Google OAuth native apps](https://developers.google.com/identity/protocols/oauth2/native-app)。
- [YouTube Data API Discovery scopes](https://www.googleapis.com/discovery/v1/apis/youtube/v3/rest) 将 `youtube.readonly` 描述为查看 YouTube 账号；`youtube.force-ssl` 覆盖视频、评分、评论和字幕的查看/编辑/删除能力。评论接口的实际范围必须按 endpoint 文档校验，不能因为操作是 list 就自行降低权限。
- [YouTube Analytics scopes](https://developers.google.com/youtube/analytics/v1/code_samples/python) 使用 `https://www.googleapis.com/auth/yt-analytics.readonly` 读取 Analytics；货币和非货币报表使用 `https://www.googleapis.com/auth/yt-analytics-monetary.readonly`。货币 scope 应单独征得用户同意，不应默认申请。
- `channels.list(mine=true)` 的 [官方文档](https://developers.google.com/youtube/v3/docs/channels/list) 只针对“当前授权用户拥有”的频道。`managedByMe` 属于 content partner/CMS 的 on-behalf-of 场景，不是普通 Brand Account 团队权限选择器。
- [YouTube Brand Account / channel permissions 帮助](https://support.google.com/youtube/answer/9367690?hl=en) 说明迁移到 Studio channel permissions 后，受邀管理者不能通过 YouTube APIs 管理频道；因此“用户能在 Studio 操作”不自动等于“该 OAuth 身份能走 API”。

### 2. Data API 可覆盖的资源

- [Channels](https://developers.google.com/youtube/v3/docs/channels) 可返回 `snippet`、`contentDetails`、`statistics`、`brandingSettings` 等请求的 parts；uploads 播放列表 ID 在 `contentDetails.relatedPlaylists.uploads` 中。
- [Playlist items](https://developers.google.com/youtube/v3/docs/playlistItems/list) 适合把 uploads 播放列表分页展开为视频 ID；再按 ID 调用 [videos.list](https://developers.google.com/youtube/v3/docs/videos) 取得视频资源 parts。
- [Comment threads](https://developers.google.com/youtube/v3/docs/commentThreads/list) 和 [comments](https://developers.google.com/youtube/v3/docs/comments/list) 可以取得线程与回复，但线程内嵌回复不保证是全部回复；需要 `parentId` 补页。
- [Live broadcasts](https://developers.google.com/youtube/v3/docs/liveBroadcasts/list)、[live streams](https://developers.google.com/youtube/v3/docs/liveStreams/list) 和 [live chat messages](https://developers.google.com/youtube/live/docs/liveChatMessages/list) 可以取得直播资源。Live Chat API 的首次列表不是历史归档接口：早于首次响应可见窗口的消息不能据此补齐。
- 公开 API key 只能取得公开资源；授权后才可能取得私有频道和 owner-only 视频字段。这是“公开元数据”与“频道运营数据”必须分开的依据，见 [Data API getting started](https://developers.google.com/youtube/v3/getting-started)。

### 3. Analytics 与 Reporting 的分工

- [Analytics API overview](https://developers.google.com/youtube/analytics) 把 Analytics 定位为按 metrics、dimensions、filters 定义的定向查询，把 Reporting 定位为适合保存和后续分析的批量报表。
- [reports.query](https://developers.google.com/youtube/analytics/reference/reports/query) 要求 `ids`、`startDate`、`endDate` 和至少一个 metric；`dimensions`、`filters`、`sort`、`maxResults`、`startIndex` 按报表能力选择。
- [Analytics dimensions](https://developers.google.com/youtube/analytics/dimensions) 和 [Analytics metrics](https://developers.google.com/youtube/analytics/metrics) 是受版本/报告组合约束的目录，不是可以任意组合的字段表。人口统计、直播、广告和留存维度都应按具体 report type 验证。
- [Reporting channel reports](https://developers.google.com/youtube/reporting/v1/reports/channel_reports) 提供预定义频道报表；[Reporting system-managed reports](https://developers.google.com/youtube/reporting/v1/reports/system_managed_reports) 中的广告/收入类报表有 content-owner 权限边界。
- [Reporting REST reference](https://developers.google.com/youtube/reporting/v1/reference/rest) 说明 job 会安排每日生成报告，随后通过 reports 列表取得下载地址；它不是按请求返回 Studio 当前卡片的同步接口。
- [Reporting revision history](https://developers.google.com/youtube/reporting/revision_history) 和报表文档说明报告可能回填、替换，旧报告会在有限窗口后删除；因此本地系统要把原始 CSV 作为可追溯工件保存。

## 未证实或明确不可用

1. **不可用：** 用 service account 代表个人频道完成 OAuth 或私有频道读取。
2. **受限：** 仅有 Studio channel permissions 的受邀管理者，不应被假设为拥有 Data/Analytics API 的同等管理权限。
3. **受限：** 普通单频道 OAuth 不能承诺 system-managed content-owner 广告/收入报表、MCN 审核字段或所有 partner 维度。
4. **未证实：** Studio 的 Realtime 卡片、实验卡片、灵感/研究类卡片、所有 UI 聚合字段都有稳定官方 API 对应物。
5. **未证实：** Analytics 所有指标统一支持任意历史起止日期、统一刷新延迟或统一分页上限。必须按指标、维度、报告类型实测并保留请求证据。
6. **不可假设完整：** Live Chat 从首次接入前的历史消息、评论线程中的全部深层回复、低隐私阈值的受众行，不能仅靠一次 list 请求补齐。

## 对下一轮产品决策的建议

1. 先定义覆盖矩阵：`Data API`（资源与运营状态）、`Analytics API`（定向指标）、`Reporting API`（每日批量历史）、`Studio-only/未发现接口`，逐项写出可用 OAuth scope 和验证命令。
2. 第一版 OAuth 使用授权码 + refresh token，首次登录后展示该用户拥有的所有 channel ID，让用户明确选择并持久化目标频道；禁止 service account、浏览器 Cookie 和网页抓取。
3. 分阶段申请 scope：基础频道清单/视频读取使用最窄可用范围；评论/审核和货币 Analytics 作为显式可选能力；所有 token、client secret、原始授权响应都不得进入 Git、日志或研究工件。
4. 采用每日增量同步加断点续传：保存请求参数、页令牌、报告 job/report ID、获取时间、API 响应和校验哈希；对 Analytics 月末收入调整和 Reporting 回填保留版本。
5. 把“完整”定义成**覆盖矩阵中所有已证实的官方能力**，而不是预下载所有指标/维度笛卡尔积。细粒度报表按需请求并缓存，配额耗尽时可恢复。
6. 在实现前用真实授权频道验证三件事：频道/Brand Account 角色能否调用 API、Analytics 指标的历史可用起点与延迟、收入/受众/直播数据是否对该账号返回；把未返回的能力标成 `unavailable` 或 `not_authorized`，不要把它们伪装成零值。

## 当前仓库关联

- 当前 CLI 的 `ops doctor` 在 OAuth 方面仅报告 `YTOPS_GOOGLE_CLIENT_ID` / `YTOPS_GOOGLE_CLIENT_SECRET` 是否配置，同时检查本机辅助工具；它没有 OAuth 登录、token 存储或 YouTube API 请求，见 [src/cli.ts](../../src/cli.ts:827) 和 [src/lib/doctor.ts](../../src/lib/doctor.ts:48)。
- 现有架构只预留 `channel.inventory`、`analytics.report` 等窄 MCP 工具；官方 API 接入仍属于后续功能，见 [docs/architecture.md](../../docs/architecture.md)。

## 研究限制

- 本条目没有使用真实频道 OAuth、不会读取或保存任何 token，也没有声称当前环境已经能取得频道数据。
- “所有 Studio 数据”的最终覆盖率仍取决于目标频道类型（个人频道、Brand Account、MCN/content owner）、角色、获利状态和目标日期范围；这些是下一轮产品决策，不是本研究可以代替用户决定的事实。
