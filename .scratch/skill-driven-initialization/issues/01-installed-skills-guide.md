# Installed Matt Pocock Skills Guide

Type: task
Status: resolved

## Scope

Document the locally installed Matt Pocock skills, add an AI-readable routing guide, and establish local triage-label vocabulary without changing the project's runtime behavior.

## Acceptance Criteria

- The guide identifies the installed-source boundary and does not misrepresent local directory hashes as upstream commits.
- `AGENTS.md` gives concrete trigger conditions, boundaries, and review/commit rules.
- The guide checks each local Skill's invocation metadata before acting and treats disabled model invocation as an explicit-user gate.
- The local tracker has the five canonical triage labels documented.

## Verification Plan

- Check the installed-skill lock metadata and local skill paths through a delegated inventory.
- Review the guide against the tracker, domain-doc, and repository safety rules.

## Review History

### Round 1: Initial independent standards review

- [P1] `AGENTS.md:21,33-37,40,45,52-57`: the guide treated matching routes as automatically invocable even when the local skill disables model invocation. **Status: fixed.** Added an explicit model-proactive versus explicit-only gate, stated that routing is not authorization, and documented the affected planning/delivery flow. **Reverification:** a second independent review must check the final guide against local skill metadata.
- [P2] `AGENTS.md:55-57` and `docs/skills/mattpocock-installed-skills.md:207-231`: legacy local copies were presented as ordinary default routes. **Status: fixed.** Moved `writing-great-skills`, `obsidian-vault`, and `edit-article` into restricted/legacy guidance; `obsidian-vault` now requires explicit authorization and a confirmed Windows vault path. **Reverification:** a second independent review must confirm the restrictions are consistent in both documents.
- [P2] this issue's review history had no first-round findings. **Status: fixed.** This round is now recorded with locations, dispositions, and required re-verification.

### Round 2: Independent dual-axis re-review

- **Standards:** no hard-standard violations or judgement-call code smells found. The independent review checked the tracked diff, all 10 untracked files, Skill metadata, CI, quality scripts, and tracker conventions. `npm run verify` (35 tests) and `git diff --check` passed.
- **Spec:** no missing requirement, scope expansion, or incorrect implementation found against `spec.md`. The 28-Skill inventory and the 16 explicit-only invocation gates match the local metadata and are not bypassed by the routing guide.
- **Disposition:** no unresolved findings remain.

## Answer

The locally installed Matt Pocock Skill catalogue, invocation-boundary guidance, `AGENTS.md` routing rules, and local triage-label vocabulary are complete and independently reviewed.

## Comments

- 2026-08-17: Claimed as part of the skill-driven initialization effort.
- 2026-08-17: Added the installed-skill catalogue, `AGENTS.md` routing guide, and local triage-label vocabulary; awaiting independent review.
- 2026-08-17: Round 1 found one P1 and two P2 documentation/routing issues; fixes are in progress and require an independent re-review.
- 2026-08-17: Round 2 independent Standards and Spec reviews found no unresolved issues; ticket resolved.
