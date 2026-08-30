# 02: 观众画像阶段默认同步

Type: task
Status: resolved
Blocked by: 01

**What to build:** 频道运营者执行核心同步时，同步范围默认包含画像阶段：频道级×日四个维度组——流量来源、国家、年龄与性别（合并为一次查询）、订阅状态，每组携带核心指标集（含互动口径）。画像数据与核心同步同构落盘（状态、数据、原始证据三件套），隐私阈值空单元格省略而非置零。订阅状态同时进入按需细分的维度白名单，运营者可立即用分析配置档案按需查询视频级订阅状态；视频级画像不进入默认同步范围。

## Answer

- 同步状态机扩为 channel → video → audience → complete,checkpoint 增加 audience 组游标,断点续传与增量恢复经测试验证;单组失败只降级 audienceCoverage(资格受限/不可用),核心事实不受影响。
- 画像行落盘 data.json 新增可选 audienceRows;state 新增可选 audienceCoverage;均为可选字段,旧文件可读。
- 订阅状态经目录模块进入按需细分白名单;覆盖矩阵新增 analytics.audience 条目(空数据 unavailable、完整 supported、部分 partial、权限 qualification-limited)。
- 修复一处既有真实 API 缺陷:provider 边界把内部维度名 trafficSourceType 映射为官方 insightTrafficSourceType(维度与筛选双处),否则画像与既有细分在真实 API 上会 400。
- 发现并沿用既有事实:maxWorkUnits 属于 input 参数;新增画像恢复用例把它放到正确位置。
- verify 全绿(287 测试)。

- [ ] 一次同步后，四个维度组的频道级×日画像数据可在仓库读取，附数据截至时间与原始证据
- [ ] 画像阶段失败（如权限不足）时覆盖状态呈现资格受限语义，核心阶段结果不受影响
- [ ] 订阅状态可作为按需细分维度查询（与核心指标自由组合）；年龄/性别不得与视频维同查的既有约束保持
- [ ] 视频级画像不出现在默认同步范围内
- [ ] 隐私阈值造成的空单元格被省略而非置零
- [ ] 库层测试覆盖画像阶段的维度组、指标集与落盘结构；覆盖矩阵测试覆盖画像能力条目；CLI 测试覆盖状态输出
- [ ] 文档合同与简体中文元数据门禁通过；verify 通过
