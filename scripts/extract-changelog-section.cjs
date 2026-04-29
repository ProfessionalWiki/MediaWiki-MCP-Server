#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { CHANGELOG_PATH } = require('./constants.cjs');

const version = process.argv[2];
if (!version) {
	console.error('Usage: extract-changelog-section.cjs <version>');
	process.exit(1);
}

const changelog = fs.readFileSync(CHANGELOG_PATH, 'utf8');

const startMarker = `## [${version}]`;
const startIdx = changelog.indexOf(startMarker);
if (startIdx === -1) {
	console.error(`No section found for version ${version} in CHANGELOG.md`);
	process.exit(1);
}

const afterHeadingIdx = changelog.indexOf('\n', startIdx) + 1;

const candidates = [
	changelog.indexOf('\n## [', afterHeadingIdx),
	changelog.indexOf('\n[Unreleased]:', afterHeadingIdx),
].filter((i) => i !== -1);
const endIdx = candidates.length > 0 ? Math.min(...candidates) : changelog.length;

process.stdout.write(changelog.slice(afterHeadingIdx, endIdx).trim() + '\n');
