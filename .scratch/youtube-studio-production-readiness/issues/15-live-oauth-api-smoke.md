# 15: 真实 OAuth、DPAPI 与官方 API 冒烟验收

Type: task
Status: open
Labels: ready-for-human
Blocked by: 03 最小授权与货币数据权限; 04 以 Inventory 贯通统一同步任务合同; 08 核心 Analytics 可信同步; 09 高维 Analytics 档案可信同步; 10 Reporting 官方任务与报告发现生命周期; 12 评论线程、回复与部分覆盖

## What to build

使用用户明确提供的测试 OAuth client 和测试频道，完成真实频道接入、Windows 受保护凭据、令牌续期及各官方数据源最小只读调用的脱敏冒烟验收。

## Acceptance criteria

- [ ] 用户明确授权使用测试 OAuth client 和测试频道，凭据只存在于受保护环境和系统存储中。
- [ ] 授权后列出所有可访问频道并由用户显式选择目标频道，不自动选择第一项。
- [ ] 进程重启后可以读取 DPAPI 受保护凭据，并至少完成一次真实访问令牌续期。
- [ ] Inventory、核心 Analytics、高维 Analytics、Reporting 和评论各完成最小只读调用，或返回与频道资格一致的受限状态。
- [ ] 评论和货币数据仅在相应 scope 已明确授权时请求，不为通过验收而隐式扩大权限。
- [ ] 真实响应中的凭据、频道内容、个人信息和原始报告不进入 Git、issue 或普通日志。
- [ ] 验收只记录脱敏命令、退出码、覆盖状态、数据截至时间和证据摘要。

## Comments
