import { McpServer } from '@modelcontextprotocol/server';
import type { BuildAppDeps } from '../../src/transport/streamableHttp.ts';
import { createAppState } from '../../src/wikis/state.ts';
import { fakeAuthPolicy } from './fakeAuthPolicy.ts';

// One source for buildApp's deps, so a field added to BuildAppDeps breaks here
// once rather than in each suite that spells the literal out. A loopback bind
// serving one public wiki, with no hosted proxy and no rate limit.
export function fakeAppDeps(overrides: Partial<BuildAppDeps> = {}): BuildAppDeps {
	return {
		state: createAppState({
			defaultWiki: 'test',
			wikis: {
				test: {
					sitename: 'Test Wiki',
					server: 'http://wiki.invalid',
					articlepath: '/wiki',
					scriptpath: '/w',
					token: null,
					username: null,
					password: null,
				},
			},
			uploadDirs: [],
		}),
		auth: fakeAuthPolicy({ transport: 'http' }),
		createServerFn: () =>
			new McpServer({ name: 'test-app', version: '0.0.0' }, { capabilities: {} }),
		host: '127.0.0.1',
		allowedHosts: undefined,
		allowedOrigins: [],
		maxRequestBody: '1mb',
		...overrides,
	};
}
