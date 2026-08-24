# 06 — 高维 Analytics 配置档案与按需查询

Type: task

What to build: 让频道运营者通过受校验的分析配置档案和临时参数，按需查询流量、设备、地域、受众和收入等高维细分数据。

Blocked by: 05 — 刷新、过期回退与配额状态.

Status: resolved

- [x] 用户可选择官方支持的指标、维度、时间范围和筛选条件，并在执行前获得组合兼容性校验。
- [x] 用户可保存并复用分析配置档案，也可为单次 CLI 查询临时覆盖允许的分析选项。
- [x] 高维细分只在请求时获取和缓存，不预下载所有可能组合。
- [x] 收入估算、受众隐私阈值和资格限制在结果中使用正确覆盖状态，不被当作正常完整数据。

## Answer

- 新增 `src/lib/breakdowns.ts` 与 `analytics-breakdown`、`analytics-profile-save`，固定支持目录并拒绝超范围/不兼容请求。
- 收入结果标记 estimated，受众维度标记 partial；不满足收入资格时返回 permission-denied，不产生零值。
- 验证：配置校验与资格限制离线测试通过。
