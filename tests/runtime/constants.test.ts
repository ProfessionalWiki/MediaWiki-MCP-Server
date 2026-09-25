import { describe, expect, it } from 'vitest';
import { resolveUserAgent } from '../../src/runtime/constants.ts';

describe('resolveUserAgent', () => {
	it('identifies the server and a contact URL by default', () => {
		expect(resolveUserAgent({})).toMatch(
			/^mediawiki-mcp-server\/\d+\.\d+\.\d+ \(https:\/\/github\.com\/ProfessionalWiki\/MediaWiki-MCP-Server\)$/,
		);
	});

	it('sends MCP_USER_AGENT in place of the default', () => {
		expect(resolveUserAgent({ MCP_USER_AGENT: 'ExampleBot/1.0 (bot@example.org)' })).toBe(
			'ExampleBot/1.0 (bot@example.org)',
		);
	});

	it('keeps the default when MCP_USER_AGENT is blank', () => {
		expect(resolveUserAgent({ MCP_USER_AGENT: '  ' })).toBe(resolveUserAgent({}));
	});
});
