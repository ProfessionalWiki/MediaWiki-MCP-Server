#!/usr/bin/env node
'use strict';

const fs = require('fs');
const {
	PACKAGE_JSON_PATH,
	SERVER_JSON_PATH,
	MANIFEST_JSON_PATH,
	CLAUDE_MARKETPLACE_JSON_PATH,
	CLAUDE_PLUGIN_JSON_PATH,
	CODEX_MARKETPLACE_JSON_PATH,
	CODEX_PLUGIN_JSON_PATH,
} = require('./constants.cjs');

const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));

// Single source of truth for the metadata shared across the distribution
// manifests. Everything but the description is read from package.json; the
// description is the wording the registry and plugins use (package.json and
// the mcpb bundle keep their own shorter one).
const metadata = {
	version: packageJson.version,
	description:
		'MCP server enabling AI clients to interact with any MediaWiki wiki through standard tools',
	keywords: packageJson.keywords,
	author: packageJson.author,
	homepage: packageJson.homepage,
	license: packageJson.license,
};

// Each manifest carries a different subset of the shared metadata, at a
// different shape, so the mapping is explicit. In `fields`, keys are dotted
// paths into the JSON and values are the metadata to write there.
const targets = [
	{
		file: SERVER_JSON_PATH,
		label: 'server.json',
		fields: {
			version: metadata.version,
			description: metadata.description,
		},
	},
	{
		file: MANIFEST_JSON_PATH,
		label: 'mcpb/manifest.json',
		fields: {
			version: metadata.version,
			keywords: metadata.keywords,
			author: metadata.author,
			homepage: metadata.homepage,
			license: metadata.license,
		},
	},
	{
		file: CLAUDE_MARKETPLACE_JSON_PATH,
		label: '.claude-plugin/marketplace.json',
		fields: {
			'plugins.0.description': metadata.description,
		},
	},
	{
		file: CLAUDE_PLUGIN_JSON_PATH,
		label: 'Claude Code plugin.json',
		fields: {
			version: metadata.version,
			description: metadata.description,
			keywords: metadata.keywords,
			author: metadata.author,
			homepage: metadata.homepage,
			license: metadata.license,
		},
	},
	{
		file: CODEX_MARKETPLACE_JSON_PATH,
		label: '.agents/plugins/marketplace.json',
		fields: {
			'plugins.0.description': metadata.description,
		},
	},
	{
		file: CODEX_PLUGIN_JSON_PATH,
		label: 'Codex plugin.json',
		fields: {
			version: metadata.version,
			description: metadata.description,
			keywords: metadata.keywords,
			author: metadata.author,
			homepage: metadata.homepage,
			license: metadata.license,
		},
	},
];

function setPath(target, dottedPath, value) {
	const keys = dottedPath.split('.');
	let node = target;
	for (let i = 0; i < keys.length - 1; i++) {
		node = node[keys[i]];
	}
	node[keys[keys.length - 1]] = value;
}

function getPath(target, dottedPath) {
	return dottedPath.split('.').reduce((node, key) => node[key], target);
}

console.log(`Syncing distribution manifests to version ${metadata.version}...`);

for (const { file, label, fields } of targets) {
	const json = JSON.parse(fs.readFileSync(file, 'utf8'));
	for (const [dottedPath, value] of Object.entries(fields)) {
		setPath(json, dottedPath, value);
	}
	fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');

	// Re-read and assert every synced field round-tripped, guarding against
	// silent drift (a future edit that breaks the JSON, drops a field, or
	// moves it out from under the path below).
	const verify = JSON.parse(fs.readFileSync(file, 'utf8'));
	for (const [dottedPath, value] of Object.entries(fields)) {
		if (JSON.stringify(getPath(verify, dottedPath)) !== JSON.stringify(value)) {
			throw new Error(`${label}: '${dottedPath}' did not round-trip after sync`);
		}
	}

	console.log(`✓ Synced ${label}`);
}
