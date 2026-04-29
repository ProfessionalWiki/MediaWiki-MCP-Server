#!/usr/bin/env node
'use strict';

const fs = require('fs');
const {
	PACKAGE_JSON_PATH,
	SERVER_JSON_PATH,
	MANIFEST_JSON_PATH,
	GEMINI_EXTENSION_JSON_PATH,
} = require('./constants.cjs');

const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
const serverJson = JSON.parse(fs.readFileSync(SERVER_JSON_PATH, 'utf8'));
const manifestJson = JSON.parse(fs.readFileSync(MANIFEST_JSON_PATH, 'utf8'));
const geminiExtensionJson = JSON.parse(fs.readFileSync(GEMINI_EXTENSION_JSON_PATH, 'utf8'));

const version = packageJson.version;

// Update server.json
serverJson.version = version;

// Update manifest.json
manifestJson.version = version;

// Update gemini-extension.json
geminiExtensionJson.version = version;

fs.writeFileSync(SERVER_JSON_PATH, JSON.stringify(serverJson, null, 2) + '\n');
fs.writeFileSync(MANIFEST_JSON_PATH, JSON.stringify(manifestJson, null, 2) + '\n');
fs.writeFileSync(GEMINI_EXTENSION_JSON_PATH, JSON.stringify(geminiExtensionJson, null, 2) + '\n');

// Post-write verification: re-read gemini-extension.json and assert the version round-tripped.
// Protects against silent sync drift (e.g., a future edit that breaks JSON or forgets the field).
const geminiVerify = JSON.parse(fs.readFileSync(GEMINI_EXTENSION_JSON_PATH, 'utf8'));
if (geminiVerify.version !== version) {
	throw new Error(
		`gemini-extension.json version mismatch after sync: expected ${version}, got ${geminiVerify.version}`,
	);
}

console.log(`✓ Updated server.json to version ${version}`);
console.log(`✓ Updated manifest.json to version ${version}`);
console.log(`✓ Updated gemini-extension.json to version ${version}`);
