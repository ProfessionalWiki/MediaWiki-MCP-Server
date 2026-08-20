import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

type Package = { registryType: string; identifier: string };

const { setImageTag } = createRequire(import.meta.url)(
	'../../scripts/update-server-json-oci.cjs',
) as {
	setImageTag: (serverJson: { packages: Package[] }, version: string) => void;
};

// The oci package sits between the other two so a lookup that takes the first
// or the last package fails here.
function serverJson(): { packages: Package[] } {
	return {
		packages: [
			{ registryType: 'mcpb', identifier: 'https://example.com/v0.1.0/Server.mcpb' },
			{ registryType: 'oci', identifier: 'ghcr.io/professionalwiki/mediawiki-mcp-server:0.1.0' },
			{ registryType: 'npm', identifier: '@professional-wiki/mediawiki-mcp-server' },
		],
	};
}

function packageOfType(json: { packages: Package[] }, registryType: string): Package {
	return json.packages.find((p) => p.registryType === registryType)!;
}

describe('setImageTag', () => {
	it('points the oci package at the released version of the image', () => {
		const json = serverJson();

		setImageTag(json, '0.2.0');

		expect(packageOfType(json, 'oci').identifier).toBe(
			'ghcr.io/professionalwiki/mediawiki-mcp-server:0.2.0',
		);
	});

	it('leaves the other packages untouched', () => {
		const json = serverJson();

		setImageTag(json, '0.2.0');

		expect(packageOfType(json, 'mcpb').identifier).toBe('https://example.com/v0.1.0/Server.mcpb');
		expect(packageOfType(json, 'npm').identifier).toBe('@professional-wiki/mediawiki-mcp-server');
	});

	it('refuses a server.json that has no oci package', () => {
		const json = { packages: [{ registryType: 'npm', identifier: 'mediawiki-mcp-server' }] };

		expect(() => setImageTag(json, '0.2.0')).toThrow('no oci package');
	});
});
