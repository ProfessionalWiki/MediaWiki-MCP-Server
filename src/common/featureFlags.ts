// Opt-in structured output. Off by default: tools advertise no outputSchema
// and emit payloads as JSON text in content[0], which works with every MCP
// client. On: tools advertise outputSchema, emit typed structuredContent
// with empty content[]. The on mode saves ~50% of the per-response tokens
// for content-heavy tools but is only safe for clients that honour
// structuredContent (SDK-based clients — Claude Desktop, Claude Code, MCP
// Inspector, VS Code Copilot, ChatGPT Apps SDK, Goose). Clients that only
// read content[] (Cursor, Cline, the Claude API mcp_servers connector)
// will silently see empty responses under the on mode.
function parseBoolEnv( name: string ): boolean {
	const raw = process.env[ name ];
	return raw === 'true' || raw === '1';
}

export const STRUCTURED_OUTPUT_ENABLED = parseBoolEnv( 'MCP_STRUCTURED_OUTPUT' );
