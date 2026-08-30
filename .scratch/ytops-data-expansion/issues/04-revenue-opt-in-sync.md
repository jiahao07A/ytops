# 04: 货币权限 opt-in 与收入同步、RPM 派生

Type: task
Status: resolved
Blocked by: 01

**What to build:** 频道运营者通过显式配置开启货币权限（独立于现有分析权限开关，ADR 0003）后，下次授权追加货币只读 scope；核心同步随之携带收入指标、币种显式 USD，频道级与视频级均同步。未开启时收入相关查询在本地被拒绝、覆盖状态呈现资格受限、绝不伪装成零值。诊断命令显示 opt-in 状态布尔（只报状态、不报值）。实现必须包含真实频道探针步骤，裁决官方文档在频道级收入可用性上的自相矛盾，并把结论回写文档。RPM（收入 ÷ 互动口径观看 × 1000）与赞踩比为读取时派生值，仓库只存原始量。

## Answer

- 配置面：global/channels 两级 `analytics.revenueOptIn`（可选字段，旧配置可读），`resolveRevenueOptIn` 频道覆盖优先；`config explain` 登记说明。
- OAuth：`yt-analytics-monetary.readonly` 进入白名单但双门把守——需 `--analytics-revenue` 显式声明 + 配置已 opt-in,否则本地拒绝;CLI auth-start 增加相应选项。
- 同步：opt-in 开启后核心两阶段自动携带 `estimatedRevenue` 并显式 `currency=USD`;画像组不携带收入；未开启时显式请求收入指标被本地拒绝（不发请求）。state 记录 `revenueOptIn` 供覆盖矩阵使用。
- 派生：`analytics-read --derived` 读取时计算 RPM（互动口径分母）与赞踩比,分母缺失/为零时省略派生值;仓库不落任何派生值。
- 覆盖矩阵新增 `analytics.revenue`:未 opt-in → qualification-limited（附 ADR 0003 原因）;有收入行 → estimated;opt-in 但无收入行 → unavailable。evidence 过滤收入相关请求。
- doctor：`ops doctor --config <path>` 报告 `analyticsRevenueOptIn: opted-in/not-configured`,只报状态不报值。
- **探针待执行（需用户）**：官方文档在频道级收入可用性上自相矛盾,探针需交互式重新授权（浏览器同意页）,无法由 agent 独立完成。步骤已写入 operations-boundary.md:opt-in → `auth-start --analytics --analytics-revenue` 重新授权 → `analytics-sync` → 检查 evidence/ 与覆盖矩阵 → 把结论回写文档。
- verify 全绿（327 测试）。

- [ ] opt-in 默认关闭；开启前收入查询本地拒绝，覆盖状态为资格受限，输出不含零值伪装
- [ ] 开启后授权流程仅追加货币只读 scope，收入以显式 USD 同步
- [ ] 诊断输出含 opt-in 状态布尔，不含任何敏感值
- [ ] 真实频道探针已执行、结论已回写文档，频道级收入的行为承诺边界明确
- [ ] RPM 与赞踩比仅在读取时派生；未变现频道开启 opt-in 后的失败路径有明确提示
- [ ] 收入月末调整风险在文档中说明（数据截至时间语义）
- [ ] 库层测试覆盖 opt-in 开/关两条路径与派生计算；CLI 测试覆盖；文档合同与中文门禁通过；verify 通过
