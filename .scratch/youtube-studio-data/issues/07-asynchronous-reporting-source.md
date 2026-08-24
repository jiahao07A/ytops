# 07 — 异步 Reporting 数据源

Type: task

What to build: 让频道运营者能够请求、观察和导入官方异步 Reporting 数据，并清楚区分报告尚未就绪、已导入和不可用状态。

Blocked by: 05 — 刷新、过期回退与配额状态.

Status: resolved

- [x] 用户可启动或配置异步报告同步，并在 CLI/JSON 中看到报告请求、等待、就绪、导入或失败状态。
- [x] 已就绪报告被保存为可查询的规范化数据及可复查原始证据。
- [x] 报告未就绪、权限不足或不适用于该频道时，系统返回覆盖状态和原因而非空成功。
- [x] 异步报告的重复检查和导入能够安全恢复，不产生重复事实数据。

## Answer

- 新增 `src/lib/reporting.ts` 与 `reporting-sync/status`，抽象请求、状态检查、下载和规范化导入边界。
- 报告请求/导入原始证据与规范化行分开保存，按行键去重，重复恢复不产生重复事实。
- 验证：离线伪 Reporting provider 覆盖 waiting、ready、imported 和幂等导入。
