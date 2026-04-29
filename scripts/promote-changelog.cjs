#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { PACKAGE_JSON_PATH, CHANGELOG_PATH } = require('./constants.cjs');

const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
const version = packageJson.version;
const today = new Date().toISOString().slice(0, 10);

const changelog = fs.readFileSync(CHANGELOG_PATH, 'utf8');

const versionHeading = `## [${version}]`;
if (changelog.includes(versionHeading)) {
	throw new Error(`CHANGELOG.md already contains a ${versionHeading} section.`);
}

const unreleasedHeading = '## [Unreleased]';
if (!changelog.includes(unreleasedHeading)) {
	throw new Error(`CHANGELOG.md is missing the ${unreleasedHeading} section.`);
}

const unreleasedLink = /^\[Unreleased\]:.*$/m;
if (!unreleasedLink.test(changelog)) {
	throw new Error('CHANGELOG.md is missing the [Unreleased] link reference at the bottom.');
}

let promoted = changelog.replace(
	unreleasedHeading,
	`${unreleasedHeading}\n\n${versionHeading} - ${today}`,
);

const repoCompareBase = 'https://github.com/ProfessionalWiki/MediaWiki-MCP-Server/compare';
const previousTagMatch = promoted.match(
	/\[Unreleased\]:.*compare\/(v[^.]+\.[^.]+\.[^.]+)\.\.\.HEAD/,
);
if (!previousTagMatch) {
	throw new Error('Could not parse previous tag from [Unreleased] link reference.');
}
const previousTag = previousTagMatch[1];
const newTag = `v${version}`;

promoted = promoted.replace(
	unreleasedLink,
	`[Unreleased]: ${repoCompareBase}/${newTag}...HEAD\n[${version}]: ${repoCompareBase}/${previousTag}...${newTag}`,
);

fs.writeFileSync(CHANGELOG_PATH, promoted);
console.log(`✓ Promoted CHANGELOG.md Unreleased section to ${version} (${today})`);
