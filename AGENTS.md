## Agent skills

### Issue tracker

Issues and specs live as local Markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Domain docs

This repository uses a single-context layout with a root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.

搜索时请使用subagent,你只接受subagent的汇总而不接触原始信息
每次开发完成后都要进行code review,而且必须使用subagent进行独立的review,根据review的结果进行修复和改进,然后再进行review,依次循环直至不再出现问题,才可向用户发起commit请求并等待批准
所有review的结果都要进行追踪