# Deployment

> **Experimental — work in progress.** The only supported hosted shape today is **single-wiki, read-only** — one wiki entry, `readOnly: true`, anonymous access. Writable and multi-wiki hosted deployments are on the roadmap but not yet safe to run. Do not expose a single MCP server to mutually untrusted users.

The server can run as a remote HTTP endpoint for clients that only accept URLs (e.g. hosted LLM chat products).

## Environment

- `MCP_TRANSPORT=http` — switch to the StreamableHTTP transport (the Dockerfile sets this by default).
- `PORT` — the port to listen on (defaults to `3000` locally and `8080` in the Docker image).

## Required configuration

```json
{
  "allowWikiManagement": false,
  "defaultWiki": "example.org",
  "wikis": {
    "example.org": {
      "sitename": "Example Wiki",
      "server": "https://example.org",
      "articlepath": "/wiki",
      "scriptpath": "/w",
      "readOnly": true
    }
  }
}
```

Exactly one wiki entry, `readOnly: true`, `allowWikiManagement: false`. Together these disable `add-wiki` and `remove-wiki`, and hide the six write tools (`create-page`, `update-page`, `delete-page`, `undelete-page`, `upload-file`, `upload-file-from-url`) from `tools/list`. The result is an anonymous, read-only MCP interface.

Do not configure `token`, `username`, or `password`. The server has no per-caller authentication; credentials in the config become shared across every caller that reaches the endpoint — almost always the wrong behaviour for a public deployment.

Place the server behind a reverse proxy that terminates TLS and applies rate limiting. Cloudflare, nginx, and Caddy all work well.

## Docker

Build and run the image locally:

```bash
docker build -t mediawiki-mcp-server .
docker run --rm -p 8080:8080 -v "$(pwd)/config.json:/app/config.json:ro" mediawiki-mcp-server
```

The image sets `MCP_TRANSPORT=http` and `PORT=8080`, runs as a non-root user, and exposes `/health` for orchestration probes. No image is published to a registry; build from source.
