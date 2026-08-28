# 17: 真实 Reporting 等待状态验收

Type: task
Status: open
Labels: ready-for-human
Blocked by: 07 显式管理 Windows 定期任务; 10 Reporting 官方任务与报告发现生命周期; 15 真实 OAuth、DPAPI 与官方 API 冒烟验收

## What to build

使用测试频道创建一个真实 Reporting job，并在官方报告尚未生成时证明任务能够安全保存等待状态、检查点和下一次轮询时间，让后续验收可以在新的上下文中继续。

## Acceptance criteria

- [ ] 用户明确授权创建只读 Reporting job，并确认目标报告类型适用于测试频道。
- [ ] 真实创建请求被官方 API 接受，任务身份和 job 与其他报告类型隔离。
- [ ] 报告未就绪时状态为 `waiting`，包含最后检查时间、下一次轮询时间和可重试信息。
- [ ] 系统调度不会高频轮询或把 waiting 误报为失败、完成或空报告。
- [ ] 进程结束后等待状态仍可读取，后续上下文不需要重新创建 job。
- [ ] 只保存脱敏 job 摘要、状态和时间，不提交凭据、频道内容或原始响应。

## Comments
