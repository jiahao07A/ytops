# ytops 数据扩展:十项指标官方 API 能力研究

Type: research
Status: resolved
Source: 2026-08-29 逐条一手来源核验(developers.google.com 各参考页 + 修订历史 + support.google.com 帮助页 + yt-dlp GitHub)
关联研究:`../youtube-studio-data/official-api-capability-research.md`(下称"既有研究";本文不重复其 OAuth/配额/分页结论,只做交叉引用)

## 研究方法与证据等级

- 全部结论以一手来源为准:YouTube Analytics API 指标/维度/报表参考页、修订历史、YouTube Reporting API 报表类型页、YouTube Data API 修订历史、YouTube 官方帮助中心、yt-dlp 官方 README 与 issue。
- 未执行真实 OAuth 请求;文中标注「需实测」的条目是文档本身存在矛盾或文档未覆盖、必须在真实授权频道上验证的点。
- ytops 现状(本文难度评级的基准):`src/lib/analytics.ts` 的 `CORE_ANALYTICS_METRICS` 白名单仅含 `views, estimatedMinutesWatched, averageViewDuration, likes, comments, shares`(带 `estimatedRevenue` 类型但见下文风险);细分维度白名单为 `video, trafficSourceType, deviceType, country, ageGroup, gender`;`src/lib/oauth.ts` 的 `ALLOWED_OAUTH_SCOPES` 白名单不含货币 scope;`src/lib/reporting.ts` 已有 Reporting API 异步同步骨架(`reportTypeId` 参数化)。

## 结论速览

| # | 指标 | 数据来源 | 需要的 scope | 粒度 | 难度评级 |
| - | ---- | -------- | ------------ | ---- | -------- |
| 1 | 点击率 CTR/缩略图展示 | Reporting API `channel_reach_basic_a1` / `channel_reach_combined_a1`(`video_thumbnail_impressions`,`video_thumbnail_impressions_ctr`,2026-01-15 新增);Analytics 频道报表表已列 `videoThumbnailImpressions`/`videoThumbnailImpressionsClickRate` 但指标参考页未收录 | `yt-analytics.readonly` | Reporting:逐日逐视频;查询通道:待实测 | 需新机制(Reporting 骨架已备);实测通过可降级小改 |
| 2 | 留存率曲线 | Analytics API `audienceWatchRatio` + 维度 `elapsedVideoTimeRatio`(另有 `relativeRetentionPerformance`/`startedWatching`/`stoppedWatching`/`totalSegmentImpressions`) | `yt-analytics.readonly` | 仅视频级(单视频 filter,100 个点);频道级只有 `averageViewPercentage` | 需新机制(非按天的新查询形态),scope 不变 |
| 3 | RPM(千次收入,美元) | 无直接 API 指标;可用 `estimatedRevenue / views × 1000` 推算(需货币指标可用,见风险)或 Studio 手动导出 | 货币指标需 `yt-analytics-monetary.readonly` | 按天/按视频(取决于收入指标可用性) | 需新 scope + 文档矛盾实测;兜底为 Studio 导出 |
| 4 | 总收入(美元) | Analytics `estimatedRevenue`(收入指标);Studio Revenue 页 | 同上;货币参数 `currency=USD`(默认即 USD) | 同上 | 同上 |
| 5a | 新观众 vs 回访观众 | 无 API 维度;Studio Audience 页的 New/Casual/Regular 卡片为 Studio 独占 | - | - | 无 API(明确不做) |
| 5b | 订阅者/非订阅者观看占比 | Analytics 维度 `subscribedStatus` + `estimatedMinutesWatched`/`views` | `yt-analytics.readonly` | 频道级与视频级均可,可按天 | 小改 |
| 5c | 地理位置 | Analytics 维度 `country`(已实现)、`province`/`city`/DMA | `yt-analytics.readonly` | 频道+视频 | 已有(扩展为小改) |
| 5d | 年龄/性别 | Analytics 维度 `ageGroup` + `gender`,指标 `viewerPercentage`(已实现) | `yt-analytics.readonly` | 频道+视频 | 已有 |
| 5e | 字幕/语言占比 | Reporting API `channel_subtitles_a3`(维度 `subtitle_language`、`subtitle_language_autotranslated`);Analytics API 无任何语言维度;yt-dlp 只有"视频可用字幕语言列表"≠观众语言分布 | `yt-analytics.readonly` | Reporting:逐日逐视频 | 需新机制 |
| 6 | 播放来源 | Analytics `insightTrafficSourceType`(已实现);细分 `insightTrafficSourceDetail` | `yt-analytics.readonly` | 频道+视频 | 已有(detail 为小改) |
| 7 | 喜欢/不喜欢比率 | Analytics `likes` + `dislikes`(`dislikes` 仍是核心指标);Data API 公开 `dislikeCount` 已于 2021-12-13 私有化;yt-dlp 无原生 dislike | `yt-analytics.readonly` | 频道+视频 | 小改 |
| 8 | 新增订阅 | Analytics `subscribersGained` / `subscribersLost`(核心指标) | `yt-analytics.readonly` | 频道级=全部来源;视频级=仅该视频观看页 | 小改 |
| 9 | 创收方式及占比 | API 仅能二分:广告 `estimatedAdRevenue` vs Premium `estimatedRedPartnerRevenue`(且需 CMS/实测,见风险);会员/SuperChat/购物收入无任何 API 指标;Studio RPM 报告含 revenue sources | 货币指标需 monetary scope | 同收入 | 无 API(会员等)——Studio 导出;广告/Premium 需新 scope+实测 |
| 10 | 热门联署商品及占比 | 无任何 API;创作者侧仅 Studio Earn/Shopping UI;商家侧 Merchant Center 分析页可下载 CSV | - | - | 无 API(明确不做;爬取排除) |

---

## 1. 点击率(缩略图展示 CTR)

**来源(已证实):**
- 官方 API 对比页明确:Reach reports"提供视频缩略图展示与点击率统计",**仅以 bulk 报表形式**对频道与内容所有者开放([Supported reports](https://developers.google.com/youtube/analytics/video_reports))。
- [Analytics API 修订历史 2026-01-15](https://developers.google.com/youtube/analytics/revision_history):Reporting API 新增 reach 报表;频道可用 `channel_reach_basic_a1` 与 `channel_reach_combined_a1`(后者组合 `traffic_source_type`/`traffic_source_detail`/`operating_system`/`device_type` 维度),新指标 `video_thumbnail_impressions`、`video_thumbnail_impressions_ctr`([报表类型页](https://developers.google.com/youtube/reporting/v1/reports/channel_reports) 同步列出,字段还包括 `date`/`channel_id`/`video_id`)。
- 当前[频道报表参考页](https://developers.google.com/youtube/analytics/channel_reports)(页面标注 2026-01-15 更新)的基础统计/按时间/地理/流量来源/设备/热门视频报表的指标清单中已出现驼峰版 `videoThumbnailImpressions`、`videoThumbnailImpressionsClickRate`。**但**[指标参考页](https://developers.google.com/youtube/analytics/metrics)全文(两次抓取核对)没有这两个指标,修订历史也未记录 Targeted Queries 新增。→ Analytics 查询通道属"表内已列、目录未收录"状态,必须实测:`reports.query` 是否接受这两个指标名。

**权限:** 现有 `yt-analytics.readonly` 即可(非货币指标);若走 Reporting API 亦同。无需变现状态。

**粒度:** Reporting 报表逐日、逐视频(`video_id` 列),频道级聚合可自行汇总;`channel_reach_combined_a1` 可按流量来源/设备拆 CTR。

**已知限制:** "registered impression"只是总触达的子集(外站、片尾等不计入),view÷impressions 不会等于官方 CTR([Impressions & CTR FAQs](https://support.google.com/youtube/answer/7628154));Studio 端该数据在 [Reach 页/单视频页](https://support.google.com/youtube/answer/9314486) 查看。缩略图展示定义:"缩略图在无交互或非自动播放时展示"([2026-08-27 修订](https://developers.google.com/youtube/analytics/revision_history))。Reporting 报表有生成/保留窗口(见横切面)。

**难度评级:需新机制** —— 正确路径是把 `channel_reach_basic_a1`(可选 `channel_reach_combined_a1`)接入 `src/lib/reporting.ts` 既有骨架(`reportTypeId` 已参数化,`src/lib/reporting.ts:74`);同时在 analytics.ts 增加这两个指标的实测探针,若查询通道可用则降级为「小改」。

## 2. 留存率曲线

**来源(已证实):**
- 指标:`audienceWatchRatio`(某时间点的观看比例,回看可致 >1)、`relativeRetentionPerformance`(对比同长度视频的相对留存,0-1)、`startedWatching`/`stoppedWatching`/`totalSegmentImpressions`([指标参考](https://developers.google.com/youtube/analytics/metrics);后三个为 [2024-05-06 修订新增](https://developers.google.com/youtube/analytics/revision_history))。
- 维度:`elapsedVideoTimeRatio`,"API 为每个视频返回 100 个数据点,比值 0.01–1.0"([维度参考](https://developers.google.com/youtube/analytics/dimensions))。
- 报表组合:频道版 Audience retention 报表**必须** `filters=video==<单个视频 ID>`(不允许逗号分隔多视频),可选过滤 `audienceType`/`subscribedStatus`/`youtubeProduct`([频道报表](https://developers.google.com/youtube/analytics/channel_reports))。频道级没有逐点留存曲线,只有 `averageViewPercentage`(平均观看百分比,可配 `subscribedStatus` 等维度)。
- Reporting API 的批量报表没有视频留存曲线(独有的是播放列表留存)[(对比页)](https://developers.google.com/youtube/analytics/video_reports)。

**权限:** `yt-analytics.readonly`。**粒度:** 仅视频级;按"视频内进度"而非按天;无频道级曲线。

**已知限制:** 数据点固定 100 个(约每 1% 进度一段);空值≠零值(隐私阈值,见横切面)。

**难度评级:需新机制(但 scope 不变)** —— 现有 sync 假设"按天聚合"(day 维度 + 365 天回填);留存是 `elapsedVideoTimeRatio` 维度、单视频 filter、非按天,需在 analytics.ts 增加第二类查询形态(逐视频一次请求,配额随视频数线性增长)。

## 3. RPM(千次收入,美元)

**来源:**
- Studio 定义:RPM = 每 1,000 次观看的收入,来源含广告、频道会员、YouTube Premium、Super Chat、Super Stickers([官方帮助](https://support.google.com/youtube/answer/9314357))。
- API 侧**没有名为 RPM 的指标**;唯一途径是 `estimatedRevenue / views × 1000` 自算,前提是 `estimatedRevenue` 可查(见风险)。`currency` 参数适用于 `estimatedRevenue`/`estimatedAdRevenue`/`estimatedRedPartnerRevenue`/`grossRevenue`/`cpm`/`playbackBasedCpm`,默认 USD,ISO 4217,不支持时返回错误([reports.query](https://developers.google.com/youtube/analytics/reference/reports/query))——ytops 指定 USD 即用默认或显式 `currency=USD`。

**高风险(文档矛盾,必须实测):** 当前[频道报表页](https://developers.google.com/youtube/analytics/channel_reports)顶部注记"Estimated revenue and ad performance metrics are not currently supported for channel reports";但同一页面的报表表和[修订历史 2017-03-28](https://developers.google.com/youtube/analytics/revision_history)("能在 Creator Studio 看到收入的频道所有者,现在也能经 API 查收入")又把 `estimatedRevenue*` 等星号指标列进基础统计/按时间/地理/热门视频报表,并列出频道版 ad performance 报表(需 monetary scope)。两说并存。收益指标还要求频道已开启变现(Studio 内可见收入)。
- 实测方案:对已变现频道用 monetary scope 发 `ids=channel==MINE&metrics=estimatedRevenue&dimensions=day`。成功 → RPM/总收入皆可自算;失败/空 → 该账号此路径不可用。
- [内容所有者报表页](https://developers.google.com/youtube/analytics/content_owner_reports) 明确收入/广告指标属于 content owner 报表(需 YPP 内容所有者身份 + monetary scope);Reporting API 的收入批量报表也仅 content owner([(对比页)](https://developers.google.com/youtube/analytics/video_reports):"Estimated revenue reports | Supported for content owners (bulk)")。

**难度评级:需新 scope + 实测(带 Studio 导出兜底)** —— ① 在 `src/lib/oauth.ts` 白名单加入 `yt-analytics-monetary.readonly`(显式 opt-in,与 force-ssl 同策略);② analytics.ts 实测收入查询;③ 不可用则提供 Studio Advanced Mode 手动导出 CSV 的导入位([导出方法](https://support.google.com/youtube/answer/9717005))。

## 4. 总收入(美元)

同第 3 项完全相同的通道与风险:API 指标为 `estimatedRevenue`(核心指标,曾名 `earnings`,"来自全部 Google 销售广告及非广告来源的预估净收入"),月末会调整,不含 partner-sold/partner-served 广告([指标参考](https://developers.google.com/youtube/analytics/metrics))。注意口径差:API `estimatedRevenue` 与 Studio Revenue 页"Estimated revenue(含会员、Premium、Super Chat)"([帮助](https://support.google.com/youtube/answer/9314357))并非承诺完全等价,展示层应标 `estimated`。难度评级同上(需新 scope + 实测/兜底)。

## 5. 观众画像

### 5a. 新观众 vs 回访观众 —— 无 API(Studio 独占)
- Analytics 维度目录中不存在 `newVsReturning` 或任何等价维度([维度参考](https://developers.google.com/youtube/analytics/dimensions),核对为 not found;最接近的是 `subscribedStatus`,语义不同——订阅状态而非观看历史)。
- Studio 的对应卡片已从"新观众/回访观众"演进为 **New / Casual / Regular viewers**,同样只在 Studio 呈现([官方帮助](https://support.google.com/youtube/answer/10246996))。
- **评级:无 API,明确不做。** 替代品:`subscribedStatus`(5b)可部分回答"老观众"问题。

### 5b. 订阅者/非订阅者观看时长占比 —— 小改
- 维度 `subscribedStatus`,取值 `SUBSCRIBED`/`UNSUBSCRIBED`,按观看发生时点的订阅状态计([维度参考](https://developers.google.com/youtube/analytics/dimensions))。
- 频道报表"User activity by subscribed status"支持按天/月分组,可与 `country` 等过滤组合;指标含 `estimatedMinutesWatched`、`views`、`likes`/`dislikes` 等([频道报表](https://developers.google.com/youtube/analytics/channel_reports));视频过滤可用。Reporting API 侧 `subscribed_status` 是 `channel_basic_a3` 的固定列([报表类型](https://developers.google.com/youtube/reporting/v1/reports/channel_reports))。
- 实现注意:人口统计类指标与 `subscribedStatus` 组合时不归一化(各分组各自合计 100%)([频道报表注记](https://developers.google.com/youtube/analytics/channel_reports))。
- **评级:小改** —— `BREAKDOWN_DIMENSIONS` 加 `subscribedStatus` 一项即可,无需新 scope。

### 5c. 地理位置 —— 已有(扩展为小改)
- `country` 已在 ytops 白名单(既有实现)。扩展项:`province`(需 `filters=country==US`)、`city`(2022-01-01 起有数据,`maxResults≤250` 且必须 `sort`)、DMA 报表(2024-05-06 新增,限美国)([维度参考](https://developers.google.com/youtube/analytics/dimensions)、[频道报表](https://developers.google.com/youtube/analytics/channel_reports)、[修订历史 2024-05-06](https://developers.google.com/youtube/analytics/revision_history))。

### 5d. 年龄/性别 —— 已有
- `ageGroup`(值 `age13-17` … `age65-`)+ `gender`(`female`/`male`/`user_specified`),指标 `viewerPercentage`([维度参考](https://developers.google.com/youtube/analytics/dimensions))。ytops 已实现。补充事实:2026-03-09 起 `ageGroup` 含 YouTube 估计的 18 岁以下用户([修订历史](https://developers.google.com/youtube/analytics/revision_history))。

### 5e. 字幕/语言占比 —— 需新机制(Reporting API 专属)
- **Analytics API 无任何观众语言/字幕维度**(维度目录核对 not found,[维度参考](https://developers.google.com/youtube/analytics/dimensions))。
- Reporting API 独有维度 `subtitle_language`(对比页"Unique dimensions"列表,[video_reports](https://developers.google.com/youtube/analytics/video_reports));频道报表 `channel_subtitles_a3`:"统计观看中**使用时长最长的**闭字幕语言;基本未开启字幕的观看不计入",列含 `subtitle_language`、`subtitle_language_autotranslated`、`subscribed_status`、`country_code` 等([报表类型](https://developers.google.com/youtube/reporting/v1/reports/channel_reports))。内容所有者另有 `content_owner_subtitles_a3`([修订历史 2025-06-24](https://developers.google.com/youtube/analytics/revision_history))。
- 口径提醒:这是"观众**用了哪国字幕**",不是"观众 UI 语言";且排除不开字幕的观看。yt-dlp 能给的只是**视频可用的字幕语言清单**(`--list-subs`,属于视频元数据)([yt-dlp README Subtitle Options](https://github.com/yt-dlp/yt-dlp#subtitle-options)),与观众语言分布是两回事。
- **评级:需新机制** —— 走 `reporting.ts` 骨架加 `channel_subtitles_a3` job。

## 6. 播放来源(流量来源)—— 已有,detail 小改
- `insightTrafficSourceType`(ytops 已实现)+ `insightTrafficSourceDetail`(如 `YT_SEARCH`→搜索词、`EXT_URL`→外链、`RELATED_VIDEO`→视频 ID);detail 报表限 `maxResults≤25` 且必须 `sort`,且部分来源不支持;流量来源报表有"视频数×天数 ≤ 50,000"限制([维度参考](https://developers.google.com/youtube/analytics/dimensions)、[频道报表](https://developers.google.com/youtube/analytics/channel_reports)、[修订历史 2024-11-15](https://developers.google.com/youtube/analytics/revision_history))。

## 7. 喜欢与不喜欢的比率 —— 小改(API 仍有 dislikes)
- **YouTube Analytics API 仍有 `dislikes` 指标,且是核心指标**("用户给视频负评的次数",与 `likes` 并列)[(指标参考)](https://developers.google.com/youtube/analytics/metrics);Reporting API `channel_basic_a3` 也含 `dislikes` 列([报表类型](https://developers.google.com/youtube/reporting/v1/reports/channel_reports))。这是频道主自有数据,不经公开面。
- 公开面早已关闭:Data API `videos.list` 的 `statistics.dislikeCount` 自 2021-12-13 起私有化,仅视频所有者授权后可见([Data API 修订历史 2021-11-18 / 2021-12-15](https://developers.google.com/youtube/v3/revision_history))。
- yt-dlp 无原生 dislike 提取;社区通过第三方 Return YouTube Dislike 插件获取(非官方、不可依赖)([yt-dlp#9236](https://github.com/yt-dlp/yt-dlp/issues/9236))。
- **评级:小改** —— `CORE_ANALYTICS_METRICS` 加 `dislikes`,比率在展示层算。注意该数据是"频道主视角的总量",不可对外当作公开踩数。

## 8. 新增订阅 —— 小改
- `subscribersGained`/`subscribersLost` 均为核心指标;频道报表口径=所有来源(观看页/频道页/首页导视),一旦用 `video` 维度或 video filter 限定,**只统计该视频观看页带来的增减**([指标参考](https://developers.google.com/youtube/analytics/metrics))。这个口径差必须在输出里注明,否则对不上 Studio。
- **评级:小改** —— 两个指标加入 metrics 白名单,现有 day 维度同步即可。

## 9. 创收方式及其占比 —— 大部分无 API
- API 可分的只有两类:广告(`estimatedAdRevenue`,曾名 `adEarnings`)与 YouTube Premium(`estimatedRedPartnerRevenue`,曾名 `redPartnerRevenue`,含音乐与非音乐内容),均受月末调整([指标参考](https://developers.google.com/youtube/analytics/metrics));可达性同第 3/4 项(频道主路径有文档矛盾,需 monetary scope 实测;content owner 路径明确需 YPP 身份 [(内容所有者报表)](https://developers.google.com/youtube/analytics/content_owner_reports))。
- **频道会员收入、Super Chat/Super Stickers、购物佣金:在 Analytics 与 Reporting API 中均无任何指标。** Analytics 中会员相关只有取消问卷统计 `membershipsCancellationSurveyResponses`(非收入)([指标参考](https://developers.google.com/youtube/analytics/metrics)、[修订历史 2024-05-06](https://developers.google.com/youtube/analytics/revision_history))。Studio 的 RPM/revenue sources 报告含这些来源([帮助](https://support.google.com/youtube/answer/9314357)),但仅 UI。
- **评级:无 API(会员/SuperChat/购物)——建议 Studio 手动导出或干脆不做;广告/Premium 二分并入第 3 项的 monetary 决策。**

## 10. 热门联署营销商品及占比 —— 无 API,爬取排除
- YouTube Shopping affiliate 是纯产品面能力:创作者在 Studio 的 Earn/Shopping 标商品、看 insights 与收益;佣金经 AdSense for YouTube 在 60–120 天后支付([官方概览](https://support.google.com/youtube/answer/13376398))。没有任何 Analytics/Reporting/Data API 指标涉及联署商品(指标与修订历史中均无;核实过程中曾疑似的 `units_sold` 条目经查证不存在)。
- 有官方导出能力的是**商家侧**:Merchant Center → YouTube affiliate → Analytics 标签页,可下载 Top creators/content/products 数据,且本身有隐私阈值说明([商家帮助](https://support.google.com/merchants/answer/14947975))。若用户同时是商家,可人工导入该 CSV;创作者侧没有等价商品级导出页面的官方记载。
- 爬取 Studio 应直接排除:仓库既有研究已把"不抓取、不用浏览器 Cookie 补缺口"定为边界(既有研究第 2 节);YouTube 开发者政策同样要求经授权 API 访问数据([Developer Policies](https://developers.google.com/youtube/terms/developer-policies))。
- **评级:无 API,明确不做(可留"商家侧 CSV 导入"作为人工通道)。**

---

## 横切面:权限、配额与口径风险

1. **Scope 现状**:`reports.query` 现在要求请求具备 `youtube.readonly`(ytops 已有)([reports.query 参考页注记](https://developers.google.com/youtube/analytics/reference/reports/query)、[修订历史 2018-06-18](https://developers.google.com/youtube/analytics/revision_history))。唯一可能新增的 scope 是 `yt-analytics-monetary.readonly`(第 3/4/9 项),应做成显式 opt-in,与既有 force-ssl 策略一致。
2. **隐私阈值(空值≠零值)**:低流量数据会被匿名化/抑制,报告可能缺行或缺值([Data Model 的 Data anonymization 节,2018-09-17 加入](https://developers.google.com/youtube/analytics/data_model)、[修订历史](https://developers.google.com/youtube/analytics/revision_history));ytops 现有空值处理保持,新增指标沿用。Merchant Center 购物分析页也有同款阈值说明([商家帮助](https://support.google.com/merchants/answer/14947975))。
3. **收入数据口径**:`estimatedRevenue` 等受月末调整、不含 partner-sold/partner-served 广告;`grossRevenue` 是毛额、归广告主支出口径,勿与净额混用([指标参考](https://developers.google.com/youtube/analytics/metrics))。展示层必须标 `estimated` + 查询日(既有研究同结论)。
4. **观看数口径正在变**:2025-03-31 起 Shorts 观看=开播/重放,`views` 随之变化,`engagedViews` 保留旧口径(Targeted Queries 2025-04-30 生效、Bulk 2025-06-30 生效,报表版本整体 a2→a3,旧版本已于 2025-10-31 弃用)([修订历史 2025-03-26 / 2025-04-24 / 2025-06-24 / 2025-09-22](https://developers.google.com/youtube/analytics/revision_history));2026-08-27 公告将进一步把全格式公开观看统一为"开播即计",变现与核心指标(CTR、平均观看时长)锚定 engaged 口径([修订历史 2026-08-27](https://developers.google.com/youtube/analytics/revision_history))。**ytops 新增指标时应同时取 `views` 与 `engagedViews`,以 engaged 为货币/变现相关口径。**
5. **Reporting API 报表保留窗口**:常规报表自生成起约 60 天、历史报表约 30 天内可取,旧报表会被删除([修订历史 2018-05-22](https://developers.google.com/youtube/analytics/revision_history);既有研究第 3 节同结论)。reach/字幕报表接入 `reporting.ts` 时必须保证至少 30 天一次的拉取频率,并保存原始 CSV。
6. **配额**:Analytics 每个查询的配额成本由服务端按查询评估([(对比页 Quota 行)](https://developers.google.com/youtube/analytics/video_reports));留存曲线(逐视频 1 请求)与 reach 查询通道(若可用)都要进既有配额预算,具体额度以 Google API Console 为准(既有研究结论沿用)。
7. **Traffic source 报表上限**:查询视频数×天数 > 50,000 会直接报错([修订历史 2024-11-15](https://developers.google.com/youtube/analytics/revision_history))。

## 避免过度复杂度的取舍建议

**值得做(一次白名单小改,无新 scope,风险低):**
- `dislikes`(第 7 项)、`subscribersGained`/`subscribersLost`(第 8 项)、`subscribedStatus` 维度(5b)、`insightTrafficSourceDetail`/`province`(5c/6 扩展)、`averageViewPercentage`(频道级留存近似, playback details 报表已支持)。
- 建议顺手补:`engagedViews`(口径对齐 2025 Shorts 变更)、`redViews`/`estimatedRedMinutesWatched`(Premium 观看面,非货币)。

**需要一次性决策的(money decision):**
- `yt-analytics-monetary.readonly` opt-in + 收入指标实测(第 3/4/9 项)。实测通过→RPM/总收入/广告-Premium 二分全部解锁(`currency` 默认 USD);实测失败→该路径只对 CMS 内容所有者开放,个人频道退回 Studio Advanced Mode 导出 CSV 的导入位。不要在实测前把收入功能写进承诺面。

**值得做但按新机制立项(复用现有骨架):**
- 留存曲线(第 2 项):analytics.ts 第二查询形态,逐视频 100 点;视频数大时注意配额与缓存。
- Reporting API 新报表(第 1/5e 项):`channel_reach_basic_a1`(+`channel_reach_combined_a1`)、`channel_subtitles_a3` 接入 `reporting.ts`;遵守 30/60 天保留窗口。

**明确不做(写进非目标):**
- 新观众 vs 回访观众(5a)——无 API,Studio 独占。
- 会员/SuperChat/购物收入拆分(第 9 项其余)——无 API。
- 联署商品占比(第 10 项)——无 API;商家侧 CSV 可作人工导入,爬取 Studio 排除。

## 与既有研究的差异(本文新增核验的内容)

相对 `../youtube-studio-data/official-api-capability-research.md`,本文新增确认:
1. **Reach/CTR 已进 API 面**(2026-01-15):Reporting API `channel_reach_basic_a1`/`channel_reach_combined_a1` 与 `video_thumbnail_impressions(_ctr)`;并识别出 Analytics 频道报表表与指标参考页的文档缺口(需实测)。既有研究未覆盖。
2. **`dislikes` 在 Analytics API 仍是核心指标**,且 Data API `dislikeCount` 私有化的准确日期(2021-12-13)与 owner-only 条件;yt-dlp 无原生 dislike。
3. **留存曲线的精确契约**:`audienceWatchRatio`+`elapsedVideoTimeRatio`、单视频 filter、100 点、可 >1;频道级仅 `averageViewPercentage`;2024-05-06 增补的三个分段指标。
4. **字幕语言报表的存在与口径**:`channel_subtitles_a3`/`subtitle_language`,"最长使用字幕语言、排除未开字幕观看";Analytics 无语言维度。
5. **收入的真实边界**:频道报表页"不支持收入"注记与 2017-03-28 修订及星号指标表并存的矛盾,收入指标真正保障面在 content owner 报表;`currency` 参数适用指标清单与默认 USD。
6. **口径变更时间线**:Shorts 观看(2025-03/04/06)与 2026-08-27 全格式观看统一公告;`engagedViews` 为稳定口径。
7. **新/回访观众无 API**、**会员收入仅有取消问卷指标**、**联署/购物无任何 API 且无 units_sold 类指标**(对疑似条目做了证伪)。

## 研究限制

- 未用真实频道执行 OAuth 查询;「需实测」条目(CTR 查询通道、频道主收入可用性)留有验证清单,实现前必须先跑探针。
- Reporting API 报表字段以官方报表类型页与修订历史为准,版本号(a1/a3)会随 YouTube 变更继续演进,实现时应以 `reportTypes.list` 实时返回为准。
