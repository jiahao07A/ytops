# Domain Docs

Engineering skills should consume this repository's domain documentation as follows.

## Before exploring

Read the relevant material when it exists:

- Root `CONTEXT.md`.
- Root `CONTEXT-MAP.md` when it exists; it points to context-specific `CONTEXT.md` files.
- Relevant ADRs under `docs/adr/`.

If these files do not exist, proceed silently. Do not create them preemptively; create domain documentation only when a real term or architectural decision needs to be recorded.

## Single-context layout

```text
/
├── CONTEXT.md
├── docs/
│   └── adr/
└── src/
```

## Vocabulary and ADRs

Use terms defined by `CONTEXT.md` consistently in issue titles, design proposals, hypotheses, and tests. If a needed term is absent, treat it as either a signal to reconsider wording or a candidate for later domain modelling.

When a proposed change contradicts an existing ADR, surface the conflict explicitly instead of silently overriding the decision.
