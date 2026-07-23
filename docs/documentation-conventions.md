# Documentation conventions

This guide is for anyone writing or editing prose documentation: `README.md`, `CHANGELOG.md`, `SECURITY.md`, the pages under `docs/`, and in-tree READMEs such as `src/auth/README.md`. Tool descriptions and parameter docs follow [tool-conventions.md](tool-conventions.md) instead.

Before writing or editing a page, fix three things: the named reader, the decision they make with the text, and a length budget. A sentence earns its place only if it changes what that reader predicts or does; otherwise cut it.

- Each fact has one home; every other page links to it instead of restating it.
- Pages state contracts and procedures; they do not derive, justify, or narrate mechanism beyond what the reader needs to act.
- The text carries no history of its own making: nothing addressed to a reviewer, a diff, or a past design discussion.
- Planning notes and working documents stay untracked; `docs/` ships only finished pages.
- When unsure whether something belongs, leave it out and list it under "considered, omitted" in the PR description.
- Improving an existing page does not lengthen it by default.

## Genres

Every page sits in one genre. Write to that genre's reader and register.

| Where | Reader, and the decision they make | Register, and what to keep out |
| --- | --- | --- |
| `README.md` | Evaluators and installers deciding whether and how to run the server | Capabilities, setup, and the tool table; no internals — self-hosting detail lives in `docs/deployment.md` |
| `CHANGELOG.md` | Users deciding whether to upgrade | Observable behaviour, per Keep a Changelog; no internal-API or library jargon |
| `SECURITY.md` | Reporters choosing where to send a vulnerability | The reporting channel and scope; nothing else |
| `docs/configuration.md` | Config authors looking up exact behaviour | Contracts and examples; no narration |
| `docs/deployment.md` | Self-hosters running the HTTP transport or the hosted OAuth proxy | Tasks and env-var tables; system model only where needed to act |
| `docs/operations.md` | Sysadmins keeping a deployment healthy | Log, probe, and metric contracts, with remedies |
| `docs/testing.md`, `docs/releasing.md` | Contributors and maintainers executing a procedure | Runbooks and checklists; no design history |
| `docs/distribution.md` | Contributors adding an install channel or editing a manifest | The channel map, manifest contracts, and the install-test runbook; no design history |
| `docs/tool-conventions.md` | Anyone adding or changing a tool | Rules and decision guides |
| `src/auth/README.md` | Maintainers orienting in the auth code | A map of roles and files; no line-level detail that goes stale |

## Never write

- The justification register: "note that", "importantly", "this ensures", "in order to", or restating the ask.
- Prose that restates what an adjacent table, signature, or example already shows.
- Named third-party MCP clients as examples in living pages; write "verified first-party clients" instead. A dated `CHANGELOG.md` entry may name them as a snapshot.
- Academic citations or study statistics; encode the rule itself. Linking a spec or vendor document that a statement depends on is fine.
- Contributor-local paths (worktree directories, agent scratch directories).
