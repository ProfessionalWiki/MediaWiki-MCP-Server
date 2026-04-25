# Releasing

How to cut a new release of the MediaWiki MCP Server. Maintainers only.

## 1. Review the CHANGELOG

[CHANGELOG.md](../CHANGELOG.md) accumulates entries under `## [Unreleased]` as PRs land. Before tagging, review that section, polish the wording, and commit any prose tweaks. The Unreleased entries become the GitHub Release body verbatim.

## 2. Create a release with `npm version`

```sh
# For patch release (0.1.1 → 0.1.2)
npm version patch

# For minor release (0.1.1 → 0.2.0)
npm version minor

# For major release (0.1.1 → 1.0.0)
npm version major

# Or specify exact version
npm version 0.2.0
```

This command automatically:

- Updates `package.json` and `package-lock.json`
- Syncs the version in `server.json`, `mcpb/manifest.json`, `gemini-extension.json`, and `Dockerfile` (via the `version` script)
- Promotes `## [Unreleased]` in `CHANGELOG.md` to `## [<version>] - <today>` and refreshes the link references
- Creates a git commit
- Creates a git tag (e.g. `v0.2.0`)

The `preversion` hook runs `npm run preflight` first (install, lint, server.json validation, test, build, bundle) and aborts the release if any step fails.

## 3. Push to GitHub

```sh
git push origin master --follow-tags
```

The `release` GitHub workflow triggers automatically on the tag and:

- Builds the `.mcpb` bundle and attaches it to a new [GitHub Release](https://github.com/ProfessionalWiki/MediaWiki-MCP-Server/releases), using the new `CHANGELOG.md` section as the release body.
- Publishes the package to [NPM](https://www.npmjs.com/package/@professional-wiki/mediawiki-mcp-server).
- Publishes to the [MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.professionalwiki/mediawiki-mcp-server).
