# 09 — 覆盖矩阵与证据审计

Type: task

What to build: 让频道运营者和 AI 调用方从 CLI/JSON 看到所有已实现数据能力的覆盖状态、限制和证据入口，以可审计方式理解“完整”的边界。

Blocked by: 06 — 高维 Analytics 配置档案与按需查询; 07 — 异步 Reporting 数据源; 08 — 评论与可读取扩展数据源.

Status: resolved

- [x] CLI/JSON 输出完整覆盖矩阵，使用已支持、部分支持、资格限制、估算或会调整、异步处理中和不可用状态。
- [x] 每个覆盖项说明适用范围、当前数据截至时间或报告状态，以及限制原因。
- [x] 用户可从查询结果定位关联原始证据和请求条件，而不暴露受保护凭据。
- [x] 未被官方能力证实的 Studio UI 数据不能被标记为已支持。

## Answer

- 新增 `src/lib/coverage.ts` 与 `ops channel coverage`，汇总 inventory、core/breakdown Analytics、Reporting 和只读评论状态。
- 覆盖输出包含范围、截至时间/报告状态、限制原因和脱敏证据路径；未实现或未经官方证实的能力保持 partial/unavailable。
- 验证：覆盖矩阵离线测试和全量 CLI JSON 测试通过。
