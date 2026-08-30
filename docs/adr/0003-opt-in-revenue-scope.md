# ADR 0003：货币分析权限的显式 opt-in

- 状态：已接受
- 日期：2026-08-30
- 影响范围：`src/lib/oauth.ts`、`src/lib/analytics.ts`、`src/lib/config.ts`、`src/cli.ts`、production-readiness 09 号 issue、README 与 skills 文档

## 背景

总收入与 RPM 类指标依赖 `estimatedRevenue`，需要 `yt-analytics-monetary.readonly` scope。implementation-audit 已记录"指标类型在白名单但 scope 未含、查询实际失败"的缺口；production-readiness 规格 09 号 issue 要求货币查询仅在显式申请货币权限后执行。先例 ADR 0001 确立了敏感能力"默认关闭、显式 opt-in"的接入模式。

## 决策

1. 货币权限**默认不申请**：OAuth scope 白名单默认不含 `yt-analytics-monetary.readonly`，与 `--analytics` 的追加机制分离，由独立的显式 opt-in 配置/标志控制。
2. 未开启 opt-in 时：收入相关查询在本地即被拒绝，缺失数据**绝不伪装成零值**；coverage 以 qualification-limited / permission 语义呈现。
3. 开启 opt-in 后：`currency` 参数**显式传 USD**（官方默认即 USD，显式化以避免歧义）。
4. 收入指标的频道级可用性存在官方文档自相矛盾（频道报表页注记与修订记录冲突）：接入后必须先用真实频道实测裁决，再承诺产品行为。

## 备选方案

- **默认申请货币 scope**：一步到位但违反最小权限与 09 号 issue 要求，扩大令牌泄露面。
- **不支持收入指标**：用户明确需要总收入与 RPM，放弃无依据。

## 风险与后果

- opt-in 增加一次授权流程；未变现频道开启 opt-in 后查询仍会失败，需 doctor 与文档提示资格要求。
- 收入指标存在月末调整，已同步的历史行可能事后变动，事实查询需保留数据截至时间语义。
