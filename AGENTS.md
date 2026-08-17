## Agent skills

### Issue tracker

Issues and specs live as local Markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

The local issue tracker uses the five canonical labels in `docs/agents/triage-labels.md`. Apply them as text metadata when a skill requires a triage state.

### Domain docs

This repository uses a single-context layout with a root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.

## Matt Pocock Skills Guide

This repository has 28 locally locked skill copies from `mattpocock/skills` under `C:\Users\A2134\.agents\skills`. They are workflow instructions for an AI agent, not runtime dependencies. Their exact local inventory, mechanisms, and status are documented in `docs/skills/mattpocock-installed-skills.md`.

### Required selection protocol

1. At the start of every non-trivial task, classify the work against the routing table below, identify the matching Skill, and determine its invocation category before acting.
2. When a skill is selected, read its `SKILL.md` completely and follow its referenced required material before implementation. A user-named skill is mandatory.
3. Split every selected skill into an invocation category before acting:
   - **Model-proactive:** only when its local front matter does **not** contain `disable-model-invocation: true`. The Agent may use it proactively when the task signal matches.
   - **Explicit-only:** when its local front matter contains `disable-model-invocation: true`. The Agent must explain why the skill is recommended and wait for the user to explicitly request it; identifying a matching row is not permission to invoke it.
4. The routing tables describe semantic fit, not an override of the invocation category. This is especially important for the planning and delivery workflow: `setup-matt-pocock-skills`, `grill-with-docs`, `to-spec`, `to-tickets`, `implement`, `triage`, and `handoff` must not be started autonomously when their local metadata disables model invocation.
5. Preserve this precedence: explicit user request, this repository's `AGENTS.md`, the selected skill, then general agent defaults. A skill never authorizes a conflicting action.
6. Use the lightest applicable workflow. Do not turn a one-file correction into a speculative design exercise, and do not use deprecated, legacy, or in-progress skills as defaults.
7. Keep project facts and decisions in the local issue tracker. Do not claim the installed copies match the upstream repository's current HEAD: their lock metadata records a directory hash, not an upstream commit.

### Engineering routing

Apply the invocation category above before following any row. An explicit-only row is a recommendation to present to the user, not an action that the Agent may begin.

| Task signal                                                                            | Use                                                                 | Required outcome or boundary                                                                                                                                          |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unsure which engineering workflow applies                                              | `ask-matt` only when explicitly requested                           | Route to the next skill; do not silently invoke it because it requires a human entry point.                                                                           |
| New repository setup or changed tracker/domain layout                                  | `setup-matt-pocock-skills`                                          | Preserve the established local Markdown tracker and domain-doc layout; do not overwrite existing conventions.                                                         |
| Ambiguous product, feature, or architecture request                                    | `grill-with-docs` then `to-spec`                                    | Resolve material choices and record durable domain/ADR decisions before implementation.                                                                               |
| Large greenfield effort with unknown technical route                                   | `wayfinder`                                                         | Create decision-focused map items first; move to `to-spec` only after the risky unknowns are reduced.                                                                 |
| A settled request needs a durable, testable contract                                   | `to-spec`                                                           | Publish a local spec with scope, acceptance criteria, constraints, and non-goals.                                                                                     |
| A spec needs independently executable work items                                       | `to-tickets`                                                        | Create tracer-bullet local issues with real blocking edges; do not split a tiny change merely for ceremony.                                                           |
| Claimed, bounded implementation task                                                   | `implement` and `tdd` where an observable behavior can be specified | Test at the highest existing seam, run the required checks, then enter independent review.                                                                            |
| Hard-to-reproduce bug, regression, or performance issue                                | `diagnosing-bugs`                                                   | Establish a reliable failing signal, prove the root cause, add a regression test, and only then fix it.                                                               |
| Change requests expose leaky APIs, unclear ownership, or poor testability              | `codebase-design`                                                   | Prefer deep modules, narrow interfaces, local reasoning, and existing boundaries over new abstraction layers.                                                         |
| Planned maintainability work without a user-visible feature                            | `improve-codebase-architecture`                                     | Identify a concrete architectural opportunity and return it to the normal spec/ticket flow; do not conduct an unbounded rewrite.                                      |
| State, interaction, parsing, or API shape is uncertain                                 | `prototype`                                                         | Build a narrow disposable proof, record the decision it proves, and do not pass the prototype off as production code.                                                 |
| A decision depends on current external facts, APIs, specifications, or primary sources | `research`                                                          | Produce a source-backed Markdown finding before relying on it. For a library, framework, SDK, API, CLI, or cloud service, fetch current Context7 documentation first. |
| A domain term is overloaded or a hard-to-reverse domain decision is reached            | `domain-modeling`                                                   | Update `CONTEXT.md` only when a term is resolved; create ADRs only for hard-to-reverse, surprising trade-offs. Never pre-create empty domain documents.               |
| An actual merge or rebase conflict is in progress                                      | `resolving-merge-conflicts`                                         | Reconcile each hunk from both sides' intent, validate, and continue; do not use it for hypothetical comparisons.                                                      |
| A fixed diff, branch, or completed task needs assessment                               | `code-review`                                                       | Independently assess Standards and Spec, track every finding in the relevant local issue, fix findings, and repeat review until no unresolved issue remains.          |
| Raw external bug or request requires classification                                    | `triage`                                                            | Turn it into a complete, reproducible, prioritized agent-ready issue. Do not re-triage tickets produced by `to-tickets`.                                              |

### Supporting routing

| Task signal                                             | Use                      | Boundary                                                                                                       |
| ------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Need to challenge a plan outside a repository           | `grill-me` or `grilling` | Ask for facts and choices, but do not pretend this creates a project specification.                            |
| A real person, session, or worktree handoff occurs      | `handoff`                | Record evidence, current state, risks, and the next action; do not create routine handoffs for every response. |
| The user is learning a concept over multiple iterations | `teach`                  | Maintain learning context and verify understanding.                                                            |

### Restricted and legacy skills

- `request-refactor-plan` and `design-an-interface` are deprecated. Use the current `grill-with-docs -> to-spec -> to-tickets` flow unless the user explicitly asks for the deprecated workflow.
- `writing-fragments` and `writing-shape` are in progress. Use them only for low-risk experimental writing and manually review their output before it affects a durable project artifact.
- `writing-great-skills` is a legacy local copy that upstream has replaced. Do not route to it by default; use it only when the user explicitly requests it and review the result manually.
- `obsidian-vault` and `edit-article` are legacy local copies that are no longer present upstream. Do not route to either by default. For `obsidian-vault`, require explicit user authorization and a confirmed Windows vault path before reading or writing anything.

搜索时请使用subagent,你只接受subagent的汇总而不接触原始信息
每次开发完成后都要进行code review,而且必须使用subagent进行独立的review,根据review的结果进行修复和改进,然后再进行review,依次循环直至不再出现问题,才可向用户发起commit请求并等待批准
所有review的结果都要进行追踪
