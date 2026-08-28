# 03: 最小授权与货币数据权限

Type: task
Status: open
Labels: ready-for-agent
Blocked by: 02 OAuth 持久续期生命周期

## What to build

让频道运营者只为自己选择的数据能力授予对应的最小 OAuth 权限，并在缺少评论、普通 Analytics 或货币 Analytics 权限时看到明确的资格限制，而不是隐式扩大授权或返回空成功。

## Acceptance criteria

- [ ] 基础频道数据、只读评论、普通 Analytics 和货币 Analytics 使用明确分级的 scope 组合。
- [ ] 货币数据只有在用户显式选择后才申请货币 Analytics 权限，默认授权不会包含该高权限 scope。
- [ ] 缺少所需 scope 的命令在访问源站前返回结构化资格限制，并说明需要的能力级别。
- [ ] 已有频道接入升级 scope 时保留频道选择和安全状态，不静默切换目标频道。
- [ ] 授权码交换、令牌续期和状态查询对实际 scope 使用一致的归一化结果。
- [ ] 自动测试覆盖权限满足、权限不足、授权撤销和用户拒绝扩权，不记录真实凭据。

## Comments
