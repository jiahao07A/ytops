# Skill-Driven Initialization Map

## Objective

Document and operationalize the locally installed Matt Pocock skills while adding a compatible, repeatable repository quality baseline.

## Frontier

No claimable frontier: all current tickets are resolved.

## Active Tickets

| Ticket                                                                               | Type | Status   | Depends on |
| ------------------------------------------------------------------------------------ | ---- | -------- | ---------- |
| [01 Installed Skills Guide](./issues/01-installed-skills-guide.md)                   | task | resolved | None       |
| [02 Quality and Automation Baseline](./issues/02-quality-and-automation-baseline.md) | task | resolved | None       |

## Decisions

- Keep the existing local Markdown tracker because the repository has no remote.
- Do not create empty domain or ADR documents.
- Keep the TypeScript version declared by `package.json`; do not add an ESLint dependency without a separately verified compatibility decision.
- Normalize existing tracked text files once so the Prettier gate has a green baseline.
- Round 2 independent Standards and Spec reviews found no unresolved issues; their evidence and answers are recorded in both resolved tickets.

## Open Questions

None.
