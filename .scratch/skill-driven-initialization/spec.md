# Skill-Driven Initialization

## Goal

Make the repository ready for repeatable AI-assisted maintenance by documenting the locally installed Matt Pocock skills, routing work to them proactively, and establishing a compatible quality and CI baseline.

## In Scope

- Verify and document the locally locked `mattpocock/skills` copies that are actually installed.
- Add an actionable skill-routing guide to `AGENTS.md`.
- Preserve the local Markdown issue tracker and add its canonical triage-label vocabulary.
- Add repository-wide editor and line-ending conventions.
- Add Prettier, format scripts, a combined verification command, and a GitHub Actions verification workflow.
- Normalize the existing tracked source, documentation, and YAML files with Prettier so the new format gate starts green.
- Record implementation decisions, validation, and every review round for this initialization effort.

## Out of Scope

- Changing product behavior, CLI contracts, media authorization rules, OAuth behavior, or MCP architecture.
- Installing the repository's YouTube skills into the global Codex skill directory.
- Adding an MCP server, credentials, cookies, downloads, a license, remote repository configuration, Dependabot, or release automation.
- Creating an empty `CONTEXT.md` or ADR merely to complete a checklist.
- Downgrading TypeScript or adding TypeScript ESLint before it supports the project's TypeScript 7 toolchain.

## Acceptance Criteria

- The guide distinguishes the 28 locally installed Matt Pocock skills from skills with other origins and tells future agents when each applies.
- The guide distinguishes model-proactive skills from local copies that require an explicit user invocation and does not let a semantic route bypass that gate.
- The project retains a local `.scratch/` tracker with an explicit triage-label vocabulary.
- `npm run format:check`, `npm run check`, `npm run test`, and `npm run verify` pass locally.
- CI performs a clean dependency install and runs the same combined verification command.
- All changes receive an independent review cycle with results tracked in the relevant local issues.

## Constraints and Existing Decisions

- The repository has no configured remote; local Markdown remains the tracker.
- The working tree began clean at commit `35a8db0`.
- The quality baseline uses the TypeScript compiler, Prettier and Vitest. The repository does not include an ESLint or `typescript-eslint` dependency; adding one requires a separately verified compatibility decision.
- User confirmation is required before creating any commit.
