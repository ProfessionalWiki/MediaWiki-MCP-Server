// Silence logger output during vitest runs so structured JSON lines
// don't leak into the reporter between test names. Tests that assert
// on stderr output override this with vi.stubEnv('MCP_LOG_LEVEL', 'debug').
process.env.MCP_LOG_LEVEL = 'silent';
