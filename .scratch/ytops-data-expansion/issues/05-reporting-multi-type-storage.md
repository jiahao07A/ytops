# 05: Reporting 多类型存储改造

Type: task
Status: resolved
Blocked by: none

**What to build:** 纯预重构票（"先让改动变容易"），为曝光报表接入铺路：Reporting 数据落盘按报表类型分目录，状态与数据互不覆盖；既有单槽位数据一次性迁移到新布局，迁移后旧路径不再写入。运营者可先后同步两种不同报表类型并分别读取、互不覆盖；覆盖矩阵的 Reporting 条目按报表类型分别呈现。幂等与短路语义保持不变。

## Answer

- 由并行 subagent 在独立 worktree 实现,3 个提交 rebase 后快进合并;与观众画像条目在 coverage.ts/coverage.test.ts/README 的交叉冲突由协调者按双方意图解决,合并后全树 317 测试通过。
- 落盘 `<dataDirectory>/reporting/<channelId>/<reportType>/`;一次性迁移为纯搬移+证据引用改写,守卫规则:目标类型目录已存在则不迁移;幂等短路保持;覆盖矩阵按类型分别呈现,空仓库保留一条 unavailable 条目。
- 自由裁量:报告类型字符集校验 `[A-Za-z0-9_-]+`;getReportingStatus 改为必填 reportType 并新增 listReportingResults;reporting-status 缺省输出列表;`.prettierignore` 排除 `.scratch/`(本地工单不参与格式门禁)。
- 遗留:迁移极端并发无锁(数据不丢失,失败重跑);非官方形态旧 reportType 不迁移需人工处理。

- [ ] 先后同步两种报表类型后，两者的状态与数据均可读取且互不覆盖
- [ ] 既有单槽位数据完成一次性迁移，迁移前后可读数据等价
- [ ] 幂等与短路语义保持（同任务重复同步不重复导入）
- [ ] 覆盖矩阵按报表类型分别呈现
- [ ] 既有 Reporting 测试迁移至新布局并保持绿；新增多类型并存测试
- [ ] 文档更新与中文门禁通过；verify 通过
