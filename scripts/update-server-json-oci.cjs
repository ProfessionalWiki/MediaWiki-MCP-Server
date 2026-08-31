#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { PACKAGE_JSON_PATH, SERVER_JSON_PATH } = require('./constants.cjs');

const IMAGE = 'ghcr.io/professionalwiki/mediawiki-mcp-server';

/**
 * Points the OCI package at the image published for this release. The registry
 * rejects a `version` field on an OCI package, so the tag in `identifier` is
 * the only place the version can go. Unlike its npm and mcpb siblings this
 * fails on a missing package rather than skipping: a silent skip would publish
 * a registry entry pointing at the previous release's image.
 */
function setImageTag(serverJson, version) {
	const ociPackage = serverJson.packages?.find((p) => p.registryType === 'oci');
	if (!ociPackage) {
		throw new Error('server.json has no oci package to point at the released image');
	}
	ociPackage.identifier = `${IMAGE}:${version}`;
}

function main() {
	console.log('Updating server.json with image tag...');

	const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
	const serverJson = JSON.parse(fs.readFileSync(SERVER_JSON_PATH, 'utf8'));

	setImageTag(serverJson, packageJson.version);
	console.log(`Image: ${IMAGE}:${packageJson.version}`);

	fs.writeFileSync(SERVER_JSON_PATH, JSON.stringify(serverJson, null, 2) + '\n');
	console.log('✓ Updated server.json with image tag successfully');
}

if (require.main === module) {
	main();
}

module.exports = { setImageTag };
