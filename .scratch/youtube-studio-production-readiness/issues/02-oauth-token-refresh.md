# 02: OAuth 持久续期生命周期

Type: task
Status: claimed
Blocked by: None (can start immediately)

## What to build

让一个已经建立频道接入的频道运营者在访问令牌过期后自动使用 Windows 受保护凭据中的刷新令牌续期，并让原来的只读操作继续执行。续期必须跨进程重启可靠工作，并在并发调用时只进行一次远端刷新。

## Acceptance criteria

- [ ] OAuth 适配层使用官方 Google 客户端完成访问令牌刷新，并保持业务层只依赖窄 provider 合同。
- [ ] 过期访问令牌会触发刷新并继续原命令；尚未过期的令牌不会产生不必要的刷新请求。
- [ ] 新响应包含刷新令牌时原子替换受保护值；未包含刷新令牌时保留原值。
- [ ] 同一频道接入的并发调用共享一次刷新结果，刷新失败不会产生相互覆盖的凭据状态。
- [ ] 进程重启后可以从 Windows 用户级受保护存储读取凭据并继续续期。
- [ ] `invalid_grant`、授权撤销、缺少刷新令牌、网络失败和无效响应映射为不同且可操作的状态。
- [ ] 令牌、客户端秘密和 Authorization 头不会进入 JSON、日志、任务状态或原始证据。

## Comments
