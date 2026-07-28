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

Commit a manifest for a client only when that client installs plugins from a repository. For any other client, add it to the README install section and commit no file.

## Plugin layout

Claude Code and Codex share one plugin directory but keep separate server declarations:

```
.claude-plugin/marketplace.json          Claude Code catalog
.agents/plugins/marketplace.json         Codex catalog
plugins/mediawiki-mcp-server/
    .claude-plugin/plugin.json           Claude Code manifest
    .codex-plugin/plugin.json            Codex manifest
    .codex-plugin/mcp.json               Codex server declaration
    .mcp.json                            Claude Code server declaration
```

Five constraints fix this shape:

- [Claude Code](https://code.claude.com/docs/en/plugin-marketplaces) reads its catalog only from `.claude-plugin/marketplace.json` at the repository root.
- [Codex](https://developers.openai.com/codex/plugins) rejects a plugin whose source path is the repository root, so the plugin is a subdirectory.
- Claude Code discovers `.mcp.json` at the plugin root, so its `plugin.json` omits `mcpServers` and that file must stay the Claude Code declaration. Codex has no such discovery and points at its own file with `"mcpServers": "./.codex-plugin/mcp.json"` (the path resolves against the plugin root).
- The declarations differ because the clients pass `CONFIG` differently, and each client's mechanism is unsafe or inert on the other. The Claude Code file substitutes `${user_config.configPath}` from the enable-time prompt declared in its manifest's `userConfig`; Codex performs no substitution and would hand the server that literal string as a path. The Codex file instead forwards `CONFIG` from the parent environment by name with `env_vars`, a key Claude Code ignores. Codex strips the environment to a small whitelist without `env_vars`, while Claude Code passes it through in full.
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

The sync script checks that last edit was made, and stops on the first target missing from the `git add` list, because an unstaged manifest is synced on disk yet left out of the tag.

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

`plugin details` and `mcp list` each report the `mediawiki` server. When iterating on the plugin files, the two CLIs pick up edits differently: Claude Code runs a directory-source marketplace live, while Codex runs a cached snapshot, so re-run `codex plugin add` after each edit. Remove the test install afterwards:

```bash
claude plugin uninstall mediawiki-mcp-server@professional-wiki
claude plugin marketplace remove professional-wiki

codex plugin remove mediawiki-mcp-server@professional-wiki
codex plugin marketplace remove professional-wiki
```

`claude plugin validate .` checks the Claude Code manifests without installing.
