# Tool Conventions

This guide is for anyone adding or modifying a tool in this MCP server. It covers tool design decisions, how to write descriptions and parameter docs, the runtime conventions for returned content, and the metadata every tool must set.

The guide has two parts:

1. **Generic principles** — applicable to any MCP server. Grounded in published tool-use guidance from Anthropic, OpenAI, and Google.
2. **MediaWiki conventions** — terminology, sibling-overlap notes, and common error patterns specific to this server.

Read both before adding a new tool or rewriting an existing one.

## Part 1 — Generic principles

### Tool design

#### One job per tool

Anthropic's engineering guidance recommends consolidating multiple actions into a single tool with an `action` parameter. OpenAI's Apps SDK recommends the opposite — one job per tool.

This codebase follows **one job per tool** (separate `create-page`, `update-page`, `delete-page`, `undelete-page`, etc.). Do not consolidate when adding new tools; match the existing pattern. This is an explicit choice, not an oversight.

### Descriptions

#### Voice and opening

Write tool descriptions in **third-person descriptive voice**. Start with a verb phrase describing what the tool does.

- Do: `"Returns a wiki page."` / `"Renders wikitext through the live wiki without saving."`
- Don't: `"This tool returns a wiki page."` (tautological preamble)
- Don't: `"You should use this tool when..."` (instructs the model in second person)
- Don't: `"Gets a page"` when the tool name already says `get-page` (tautology — add nothing)

Third-person descriptive voice avoids point-of-view inconsistencies that degrade tool discovery. The description is injected into the system prompt; it should read as a capability statement, not a prompt fragment.

#### Coverage: what, when, parameters, caveats

Every description answers at least:

1. **What** the tool does.
2. **What it returns.** Name the shape (e.g. "a compact text diff", "rendered HTML or wikitext source") when the tool name doesn't already convey it.

Depth scales from there based on how much there is to disambiguate. Longer descriptions are warranted when any of the following apply:

- **Sibling overlap.** Another tool in the set does something similar. State when to use this vs. the other.
- **No implicit trigger.** Every description should convey the situation in which this tool is the right choice. The trigger can be carried by canonical domain terminology in the opening (e.g. "wiki page"), by sibling routing ("For X, use Y"), or by an explicit clause ("Use when..."). When none of those is present and the tool name alone is too generic to disambiguate against tools in other servers, add the explicit clause.
- **Non-obvious constraints.** Input combinations that are rejected, behaviour at boundaries, capped or truncated output.
- **Usage hints.** Soft recommendations that help the model pick this tool for the right workflow.

Apply proportional depth: don't pad simple tools with filler, don't keep tautological tools short. A one-sentence description is fine when there's nothing more to say; a paragraph is fine when there is.

When trimming for context-window cost, cut hedging and incidental detail first; preserve trigger conditions, parameter semantics, and return shape.

#### Don't duplicate the schema

The JSON Schema generated from zod already tells the model:

- Parameter names, types, and required-vs-optional.
- Enum values (use `z.enum(...)` or `z.nativeEnum(...)` — the model sees them).
- Defaults (use `.default(...)` — the model sees them).

Do not restate this in prose. Prose is for context the schema cannot express.

#### Avoid tautology

A description that restates the tool name adds zero information. `"Deletes a wiki page"` for `delete-page` is a bad description. A better description says what "delete" means in MediaWiki (deleted pages are recoverable via `undelete-page` until purge), what the tool returns, and what errors the caller might see.

#### Avoid hedging

Don't soften capability statements with "may", "might", "possibly", or "could". State the behaviour, including its conditional branches.

- Do: `"Returns the page source. Errors with not_found when the title does not exist."`
- Don't: `"May return the page source, possibly erroring if the page doesn't exist."`

Hedging trains the model to treat the tool as unreliable. State conditions explicitly instead.

#### Sibling disambiguation with inline routing hints

When two tools in the set overlap, each description should explicitly say when to pick it vs. the other. Use the pattern "Use this instead of X when Y" or "For Z, use X instead."

Examples applicable to this server:

- `get-page` vs `get-pages`: single vs. batch.
- `search-page` vs `search-page-by-prefix`: full-text vs. title-prefix.
- `get-revision` vs `get-page` with `metadata=true`: specific historical revision vs. latest with metadata.
- `compare-pages` vs. fetching two sources and diffing client-side.

#### Don't instruct the model imperatively

Describe the condition under which the tool is useful; let the model decide whether to call it.

- Do: `"Required before interacting with a new wiki."`
- Don't: `"You MUST call this tool before interacting with a new wiki."`

The rule targets general imperatives aimed at the model ("You MUST...", "You should..."). Sibling routing hints that describe a choice — "For X, use Y" — are allowed because they describe tradeoffs about when each tool is appropriate, not commands. Prefer the "For X, use Y" pattern over "Prefer this over Y" or "Use this instead of Y," which read as instructions to the model.

Imperative instructions to the model ("You should...", "You MUST...") in tool descriptions reduce robustness across different LLM implementations.

#### Name observable side effects

Annotation hints (`destructiveHint`, `idempotentHint`, `openWorldHint`) carry the boolean classification. The description carries the *specific* effect when it isn't obvious from the verb. `delete-page` is obvious; `upload-file-from-url` is not — the description should make clear that the file is fetched server-side, whether it overwrites, and whether the upload is logged. State only effects that are observable to the caller or visible on the wiki, not implementation incidentals.

### Parameter docs

#### Parameter descriptions

Every parameter has a `.describe()` call. Parameter docs complement the schema; they do not duplicate it.

Parameter descriptions must:

- **State the parameter's role, not only its shape.** Describe what the parameter selects, filters, or controls, in the tool's own terms. `"Integer ID of a user"` is shape; `"Filters revisions to those authored by this account"` is role. The schema already conveys shape.
- **State format when non-obvious.** `"Revision ID"` is fine for an integer parameter; `"MCP resource URI of the wiki (e.g. mcp://wikis/en.wikipedia.org)"` is better than `"Wiki URI"`.
- **Call out cross-parameter constraints.** E.g. `"If olderThan is set, newerThan must not be."` when such a constraint exists.
- **Reuse canonical phrases** from Part 2 for recurring concepts (page title, revision ID, wikitext, namespace, etc.).
- **Not restate the zod type.** `"Optional integer"` is redundant when the schema is `z.number().int().optional()`.
- **Be concise.** A sentence or two per parameter. Complex behaviour belongs in the tool description, not in every parameter.

### Runtime behavior

#### Result caps and truncation signaling

Tools that return variable-size result sets or content bodies have a per-call cap. When the cap is hit, the tool appends a trailing text block to `content` describing the truncation. Three shapes:

- **With continuation** (the caller can fetch more): `"More results available. Returned N <items>. To fetch the next segment, call <tool-name> again with <param>=<value>."`
- **Without continuation** (the only remedy is a narrower query): `"Result capped at N <items>. Additional <items> may exist — <narrow-hint>."`
- **Content truncated** (the response body exceeded the byte budget): `"Content truncated at N of M bytes. [Available sections: 0 (Lead), 1 (<heading>), ....] <remedy>"` where `<remedy>` is a full sentence of the form `"To <purpose>, <action>."` (e.g. `"To read a specific section, call get-page again with section=N."`), matching the connector-phrase pattern used by the `more-available` shape.

Descriptions for these tools state the cap explicitly. If continuation is supported, descriptions reference the continuation parameter by name so the LLM can pick the right parameter without inspecting the schema.

The byte budget for content bodies is centrally resolved via `resolveContentMaxBytes()` in `src/results/truncation.ts` — it reads the `MCP_CONTENT_MAX_BYTES` environment variable and falls back to `DEFAULT_CONTENT_MAX_BYTES` (50000). Tools do not invent their own limits. Section-aware tools (`get-page`, `get-pages`) include a section list in the marker so the caller can navigate without a follow-up "list sections" call.

This convention doesn't apply to tools that reject oversize input (e.g. `get-pages`' 50-title cap): those return an error, not a truncation marker.

There is no MCP-spec-level budget for tool output. Cap sizes are chosen to stay well under Anthropic's 25,000-token Claude Code default ([Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)) and revisited when [MCP discussion #2211](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/2211) ratifies a standard.

### Metadata

#### Annotation hints

MCP's `ToolAnnotations` exposes four boolean hints that shape how clients route and display tools. Spec defaults exist, but **every tool in this repository sets all four explicitly** because OpenAI's ChatGPT developer mode rejects MCP submissions missing `readOnlyHint`, `destructiveHint`, or `openWorldHint`.

Semantics (from the MCP 2025-11-25 spec):

- **`readOnlyHint`** — if `true`, the tool does not modify its environment. Master switch; when `true`, the other behavioural hints are semantically irrelevant (but still set explicitly for clarity and cross-client compatibility).
- **`destructiveHint`** — if `true`, the tool may perform destructive updates (delete, overwrite, remove). If `false`, the tool performs only additive updates (create new without replacing). Only meaningful when `readOnlyHint: false`. Spec default is `true`.
- **`idempotentHint`** — if `true`, calling the tool repeatedly with the same arguments has no additional effect on the environment beyond the first call. A call that errors but leaves state unchanged still counts as idempotent. Only meaningful when `readOnlyHint: false`. Spec default is `false`.
- **`openWorldHint`** — if `true`, the tool interacts with external entities (e.g. a remote API). If `false`, the tool's world is self-contained (server-local state only). Spec default is `true`.

**Decision guide:**

- Pure read-only tools: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true` (for tools that read from the wiki).
- Write tools that delete, overwrite, or remove: `readOnlyHint: false`, `destructiveHint: true`.
- Write tools that only add (create, append, upload-new): `readOnlyHint: false`, `destructiveHint: false`.
- If the tool does not make network calls and only mutates server-local state (e.g. selecting the active wiki), `openWorldHint: false`.

#### Tool titles

The `title` field on `ToolAnnotations` is a human-readable UI label. Use **sentence case**, **imperative verb phrasing**:

- Do: `"Get page"`, `"Compare pages"`, `"Preview wikitext"`.
- Don't: `"Get Page"` (title case), `"Page retrieval"` (nominal phrasing).

Primarily a UI label. Don't rely on `title` for model routing — put disambiguation in the description.

## Part 2 — MediaWiki conventions

### Terminology

#### Canonical terminology

Use these exact terms in descriptions and parameter docs. Do not introduce synonyms.

| Concept | Canonical term | Notes |
|---|---|---|
| Addressable content unit | **wiki page** | Not "article" (which is a specific namespace). |
| Human-readable title | **page title** | Includes namespace prefix for non-main namespaces (e.g. `Talk:Foo`, `File:Bar.png`). |
| Numeric revision identifier | **revision ID** | Not "revision number" or "revid". |
| MediaWiki markup source | **wikitext** | Never "wiki source" or "wiki markup" in user-facing prose. |
| Namespace identifier (integer) | **namespace ID** | Parameter descriptions state "Namespace ID"; prose may mention the namespace name parenthetically. |
| Content format (wikitext, javascript, css, etc.) | **content model** | Matches MediaWiki's `contentmodel` API field. |

#### Page title vs file title

File titles are page titles in the File namespace. The distinction surfaces at the parameter level:

- For tools operating on any page (including file pages): use `"Wiki page title"` in the parameter description.
- For tools operating specifically on file pages (`get-file`, `upload-file`, `upload-file-from-url`): use `"File title"` in the parameter description for clarity.

Do not interchange these.

#### Common MediaWiki error patterns

Each tool error returns as a single text block shaped `category: message`, with `isError: true`. The category lets an LLM caller pattern-match the failure class (see "Error categories" below for the full set); the message carries the detail. Tool descriptions name the *conditions* a tool can fail on (e.g. "if the page does not exist"), never the category — the taxonomy lives only in this section.

- **`badtags`** — the configured change tag is either unregistered or not applicable to this action. Surfaces from write tools when the wiki's `tags` config is misset. Category: `invalid_input`.
- **`missingtitle`** — the target page does not exist. Surfaces from `get-page`, `update-page`, `compare-pages`, `get-page-history`. Category: `not_found`.
- **`nosuchrevid`** — the requested revision ID does not exist. Surfaces from `get-revision`, `compare-pages`. Category: `not_found`.

Example phrasing: `"Returns a wiki page. If the title does not exist, an error is returned."` — not `"...a missingtitle error is returned."`

#### Error categories

Seven categories cover every error a tool emits:

| Category | When it's emitted | Typical LLM response |
|---|---|---|
| `not_found` | Target page, revision, section, or file does not exist. | Re-check the identifier; search if appropriate. |
| `permission_denied` | The authenticated user lacks the permission (including page protection and abuse-filter blocks). | Surface to the user; don't retry as the same user. |
| `invalid_input` | Arguments are incompatible or malformed, or the wiki rejected them as invalid. | Fix the arguments and retry. |
| `conflict` | Edit conflict (`latestId` mismatch), `create-page` on an existing title, or `upload-file` without overwrite. | Re-read the latest state; reconcile; retry. |
| `authentication` | Credentials are missing, invalid, or expired. | Re-authenticate; don't retry as anonymous. |
| `rate_limited` | The wiki throttled this caller. | Back off and retry. |
| `upstream_failure` | Unclassified MediaWiki error, network failure, read-only mode, or any unexpected throw. | Retry with caution; surface if persistent. |

Unrecognised MW error codes fall through to `upstream_failure` with the raw message preserved — information survives, just at a coarser category.

Worked examples:

```
not_found: Page "Example" not found
invalid_input: Must supply exactly one of fromRevision, fromTitle, fromText
upstream_failure: Failed to create page: The wiki is currently in read-only mode.
```

### This codebase

#### Sibling overlap pairs

When writing or updating a tool in these pairs, each side's description should explicitly say when to use it vs. the other:

- **`get-page` vs `get-pages`** — single page (supports full content formats including HTML) vs. batch (up to 50 pages, source or none).
- **`search-page` vs `search-page-by-prefix`** — full-text content search vs. title-prefix search.
- **`get-revision` vs `get-page` with `metadata=true`** — fetch a specific historical revision vs. fetch the latest revision with metadata attached.
- **`compare-pages` vs. client-side diff** — `compare-pages` computes the diff server-side and returns a compact text diff; prefer it over fetching both sources and diffing locally.
- **`upload-file` vs `update-file`** — create a new file (rejects if the title already exists) vs. upload a new revision of an existing file (rejects if the title does not exist).
- **`upload-file-from-url` vs `update-file-from-url`** — same pairing for URL-source uploads.
