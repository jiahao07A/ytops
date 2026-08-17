# Issue tracker: Local Markdown

Issues and specs for this repository live as Markdown files in `.scratch/`.

## Conventions

- Use one directory per feature: `.scratch/<feature-slug>/`.
- Store a feature specification at `.scratch/<feature-slug>/spec.md`.
- Store one implementation issue per file at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`.
- Record the current issue state in a `Status:` line near the top of each issue.
- Append comments and conversation history under a `## Comments` heading.

## Publishing work

When a skill says to publish work to the issue tracker, create a file under `.scratch/<feature-slug>/`, creating that directory only when the work needs it.

## Fetching work

When a skill says to fetch a ticket, read the referenced local Markdown file. The user will normally provide its path or issue number.

## Wayfinding operations

- The map is `.scratch/<effort>/map.md`, containing notes, decisions so far, and unresolved questions.
- Each child ticket is `.scratch/<effort>/issues/<NN>-<slug>.md`, with a `Type:` line of `research`, `prototype`, `grilling`, or `task`, and a `Status:` line of `claimed` or `resolved`.
- A `Blocked by: NN, NN` line records dependencies. A ticket is unblocked once every listed ticket is resolved.
- The frontier is the lowest-numbered open, unblocked, unclaimed child ticket.
- Before work, set `Status: claimed`; when finished, append an `## Answer` section, set `Status: resolved`, and record a concise pointer in the map's decisions section.
