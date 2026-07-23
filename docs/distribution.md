# Distribution

For contributors adding an install channel, editing a plugin manifest, or testing an install before publishing. Release mechanics live in [releasing.md](releasing.md).

## Channels

| Artifact | Defined in |
| --- | --- |
| npm package | `package.json` |
| MCP registry entry | `server.json` |
| `.mcpb` bundle | `mcpb/manifest.json` |
| Docker image | `Dockerfile` |
| Claude Code plugin | `.claude-plugin/marketplace.json` and the plugin directory |
| Codex plugin | `.agents/plugins/marketplace.json` and the plugin directory |

Every plugin manifest is a wrapper that launches the published npm package with `npx`. The `.mcpb` bundle and the Docker image each ship their own build instead.

Commit a manifest for a client only when that client installs plugins from a repository. For any other client, add a copy-paste `npx` snippet to the README install section and commit no file.

## Plugin layout

Claude Code and Codex share one plugin directory and one server declaration:

```
.claude-plugin/marketplace.json          Claude Code catalog
.agents/plugins/marketplace.json         Codex catalog
plugins/mediawiki-mcp-server/
    .claude-plugin/plugin.json           Claude Code manifest
    .codex-plugin/plugin.json            Codex manifest
    .mcp.json                            the shared server declaration
```

Four constraints fix this shape:

- [Claude Code](https://code.claude.com/docs/en/plugin-marketplaces) reads its catalog only from `.claude-plugin/marketplace.json` at the repository root.
- [Codex](https://developers.openai.com/codex/plugins) rejects a plugin whose source path is the repository root, so the plugin is a subdirectory.
- Claude Code discovers `.mcp.json` at the plugin root, so its `plugin.json` omits `mcpServers`. Codex has no such discovery and points at the same file with `"mcpServers": "./.mcp.json"`.
- The catalogs take different `source` shapes: a bare string for Claude Code, an object for Codex.

Keep `.mcp.json` inside the plugin directory. Claude Code loads a repository-root `.mcp.json` as a project server, which would start this server for anyone working in this repository.

## Fields the sync script owns

`scripts/sync-manifests.cjs` runs on `npm version` and re-reads each file to confirm the write. Each manifest takes a different subset:

| Manifest | Fields written |
| --- | --- |
| `server.json` | `version`, `description` |
| `mcpb/manifest.json` | `version`, `keywords`, `author`, `homepage`, `license` |
| `.claude-plugin/marketplace.json` | `plugins[0].description` |
| `.agents/plugins/marketplace.json` | `plugins[0].description` |
| `plugins/mediawiki-mcp-server/.claude-plugin/plugin.json` | `version`, `description`, `keywords`, `author`, `homepage`, `license` |
| `plugins/mediawiki-mcp-server/.codex-plugin/plugin.json` | `version`, `description`, `keywords`, `author`, `homepage`, `license` |

`package.json` supplies `version`, `keywords`, `author`, `homepage`, and `license`; the shared `description` is a constant in the script. The script does not write `package.json`, and `mcpb/manifest.json` keeps its own shorter description.

Do not hand-edit a field in that table, because the next release overwrites it. Change the value at its source, then run:

```bash
npm run sync-manifests
```

Everything else in these files is hand-maintained, including each catalog's top-level `description` and `interface`. In `server.json` the script sets only the top-level pair; the `packages[]` entries are written during the release workflow by `scripts/update-server-json-npm.cjs` and `scripts/update-server-json-mcpb.cjs`.

Adding a manifest to the sync takes three edits:

- a path constant in `scripts/constants.cjs`
- a `targets` entry in `scripts/sync-manifests.cjs`
- the file added to the `git add` list in the `version` script in `package.json`, so the bump lands in the release commit

## Testing an install

Both CLIs accept a local directory as a marketplace source, so an install can be exercised before publishing. From the repository root:

```bash
claude plugin marketplace add ./
claude plugin install mediawiki-mcp-server@professional-wiki
claude plugin details mediawiki-mcp-server@professional-wiki

codex plugin marketplace add ./
codex plugin add mediawiki-mcp-server@professional-wiki
codex mcp list
```

`plugin details` and `mcp list` each report the `mediawiki` server. Remove the test install afterwards:

```bash
claude plugin uninstall mediawiki-mcp-server@professional-wiki
claude plugin marketplace remove professional-wiki

codex plugin remove mediawiki-mcp-server@professional-wiki
codex plugin marketplace remove professional-wiki
```

`claude plugin validate .` checks the Claude Code manifests without installing.
