# 07: 端到端验收与文档收口

Type: task
Status: resolved
Blocked by: 02, 03, 04, 06

**What to build:** 对整个数据扩展特性做最终一致性验收与收口：覆盖矩阵新增观众画像、留存曲线、曝光/CTR、收入四类能力条目齐全且状态映射正确；README、skills 与架构文档同实际命令面一致；全量校验与真实账号冒烟逐条核对规格验收标准；收口白名单多处登记与文档合同的任何漂移。

## Answer

- **覆盖矩阵**：analytics.audience、retention.curve、analytics.revenue、reporting.async(按报表类型,含 channel_reach_basic_a1)全部落地,状态映射与证据过滤经测试验证。
- **两轴 code-review**（固定点 a8ddd32）：Standards 无硬违规;Spec 发现"按需收入查询未查 opt-in"的意图不符——已修复(breakdowns 本地拒绝门 + 测试),另修复:opt-in 但无收入行的覆盖原因、`analytics-read --derived` 覆盖视频行、doctor 资格提示、月末调整写入边界文档。Standards 的判断项(retention.ts 与 analytics.ts 的辅助函数重复、readableError 分支形状重复等)记录为后续 `improve-codebase-architecture` 候选,不在本票强改。
- **门禁**：`npm run verify` 全绿(334 测试/28 文件),含 skills 入口字符串合同与简体中文元数据门禁。
- **审查-修复循环(共十轮)**:每轮由 Standards/Spec 两个独立 subagent 对照 `git diff a8ddd32...HEAD` 审查,协调者修复后进入下一轮。轮次轨迹:R1 发现意图不符与多处不完整(已修);R2 发现 CLI 选项未接线与 reporting 重复(已修);R3 轻微项(已修);R4 常量单一来源(已修);R5-R9 逐轮收敛(共享 fs-json/错误基类/HTTP 分类阶梯/freshness 校验/coverage 映射全部落地,死导入、下行断言、文档缺口逐轮清除);R10 两轴同时零发现,循环终止。有意保留项(空态条目 source 语义、stale/freshness 并存合同、三阶段显式展开、解析器隐私语义差异、既有模块重复)均在 Answer 论证并写入豁免清单。
- **待用户执行**：真实账号冒烟与两项探针(货币收入可用性、reach 报表真实列名)需交互式授权,步骤已写入 operations-boundary.md;执行后回写结论即可关闭 ADR 0003 的实测裁决项。

- [ ] 覆盖矩阵四条新能力条目齐全、状态语义正确、证据路径不含凭据样文本
- [ ] README、skills、架构文档与实际命令面一致；skills 入口字符串合同与简体中文门禁全绿
- [ ] 全量校验（verify）通过
- [ ] 规格验收标准逐条核对并记录结果
- [ ] 真实账号冒烟（授权、同步、事实查询）完成并记录数据截至时间
