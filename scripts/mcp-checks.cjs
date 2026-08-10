#!/usr/bin/env node
'use strict';

// Runs the token-free MCPJam checks against the built server:
// a stdio doctor sweep and an MCP protocol conformance run against
// the HTTP transport. CI runs this via `npm run check:mcp`; the
// tool-surface diff against the PR base lives in ci.yml because it
// needs a second checkout to diff against.

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_ENTRY = path.join(REPO_ROOT, 'dist', 'index.js');
const CONFIG_PATH = path.join(__dirname, 'mcp-checks.config.json');
const MCPJAM_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'mcpjam');
const PROTOCOL_VERSION = '2026-07-28';
const PORT = Number(process.env.PORT) || 3117;
const SERVER_URL = `http://127.0.0.1:${PORT}/mcp`;
const STARTUP_TIMEOUT_MS = 15000;

// Neither check can run against this server, and neither is a gap to close.
// modern-undeclared-capability-error needs a tool that asks the caller for
// input, so that it can prove the server rejects a client which never
// declared that capability; this server has no such tool, and the check
// bails before it contacts the server at all. modern-subscription-graceful-close
// waits for the completion result a server sends when it tears a subscription
// down, which this server does send on shutdown, but the check only aborts
// its own end of the stream and so can never observe one.
const TOLERATED_UNRUN_CHECKS = [
	'modern-undeclared-capability-error',
	'modern-subscription-graceful-close',
];

// A run that selected next to nothing establishes nothing, and the suite
// reports exactly that as an incomplete run with an empty check list. Real
// runs select 31 checks against a 2025-era suite and 36 against a 2026-era one.
const MIN_SELECTED_CHECKS = 20;

function runDoctor() {
	console.log('\nRunning MCPJam server doctor (stdio)...');
	const result = spawnSync(
		MCPJAM_BIN,
		[
			'server',
			'doctor',
			'--transport',
			'stdio',
			'--command',
			process.execPath,
			'--args',
			DIST_ENTRY,
			'--cwd',
			REPO_ROOT,
			'--env',
			`CONFIG=${CONFIG_PATH}`,
			'--env',
			'MCP_TRANSPORT=stdio',
			'--no-telemetry',
			'--quiet',
		],
		{ encoding: 'utf8' },
	);

	if (result.error) {
		console.error(`Doctor failed to start: ${result.error.message}`);
		return false;
	}

	let report;
	try {
		report = JSON.parse(result.stdout);
	} catch {
		console.error('Doctor did not produce parseable JSON:');
		console.error(result.stdout);
		console.error(result.stderr);
		return false;
	}

	const failed = Object.entries(report.checks ?? {}).filter(
		([, check]) => check.status !== 'ok' && check.status !== 'skipped',
	);
	for (const [id, check] of failed) {
		console.error(`✗ ${id}: ${check.status} — ${check.detail ?? ''}`);
	}
	if (report.status !== 'ready' || failed.length > 0) {
		console.error(`Doctor status: ${report.status}`);
		if (report.error) {
			console.error(report.error);
		}
		return false;
	}

	const tools = report.tools?.length ?? 0;
	const resources = report.resources?.length ?? 0;
	console.log(`✓ Doctor ready: ${tools} tools, ${resources} resources`);
	return true;
}

async function respondsOverHttp() {
	try {
		// Any HTTP response, including an error status, means something
		// is accepting connections on the port.
		await fetch(SERVER_URL, { method: 'GET', signal: AbortSignal.timeout(2000) });
		return true;
	} catch {
		return false;
	}
}

async function waitForServer(child) {
	const deadline = Date.now() + STARTUP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			return false;
		}
		if (await respondsOverHttp()) {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return false;
}

async function runConformance() {
	if (await respondsOverHttp()) {
		console.error(`Port ${PORT} is already in use by another process — set PORT to a free port.`);
		return false;
	}

	console.log(`\nStarting HTTP transport on port ${PORT}...`);
	const serverLog = [];
	const child = spawn(process.execPath, [DIST_ENTRY], {
		cwd: REPO_ROOT,
		env: {
			...process.env,
			MCP_TRANSPORT: 'http',
			CONFIG: CONFIG_PATH,
			PORT: String(PORT),
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	child.stdout.on('data', (chunk) => serverLog.push(chunk));
	child.stderr.on('data', (chunk) => serverLog.push(chunk));
	// Armed before the child can possibly exit, so the finally block's
	// await resolves even when the child is already dead by then.
	const exited = new Promise((resolve) => child.once('exit', resolve));

	try {
		if (!(await waitForServer(child)) || child.exitCode !== null) {
			console.error('HTTP transport did not become reachable:');
			console.error(serverLog.join(''));
			return false;
		}

		console.log(`Running MCP protocol conformance (${PROTOCOL_VERSION})...`);
		const result = spawnSync(
			MCPJAM_BIN,
			[
				'protocol',
				'conformance',
				'--url',
				SERVER_URL,
				'--protocol-version',
				PROTOCOL_VERSION,
				'--no-telemetry',
			],
			{ encoding: 'utf8' },
		);

		if (!reportConformance(result)) {
			console.error('Server log:');
			console.error(serverLog.join(''));
			return false;
		}
		return true;
	} finally {
		child.kill('SIGTERM');
		await exited;
	}
}

// The suite withholds a verdict whenever a check could not run, so its exit
// code reads the same for a server that violated the protocol and for a run
// that proved nothing. Judge the report instead.
function reportConformance(result) {
	if (result.error) {
		console.error(`Conformance failed to start: ${result.error.message}`);
		return false;
	}

	let report;
	try {
		report = JSON.parse(result.stdout);
	} catch {
		console.error(`Conformance did not produce parseable JSON (exit ${result.status}):`);
		console.error(result.stdout);
		console.error(result.stderr);
		return false;
	}

	const problems = judgeConformanceReport(report);
	if (problems.length > 0) {
		for (const problem of problems) {
			console.error(`✗ ${problem}`);
		}
		console.error('Conformance report:');
		console.error(result.stdout);
		return false;
	}

	console.log(`✓ Conformance: ${report.summary}`);
	const tolerated = unrunCheckIds(report).join(', ');
	if (tolerated) {
		console.log(`  Tolerated as unrunnable, so not asserted: ${tolerated}`);
	}
	return true;
}

// Returns one message per reason to reject the run, so an empty list is a pass.
function judgeConformanceReport(report) {
	const checks = Array.isArray(report?.checks) ? report.checks : [];
	const problems = [];

	if (checks.length < MIN_SELECTED_CHECKS) {
		problems.push(
			`the run selected ${checks.length} of the ${MIN_SELECTED_CHECKS} checks it takes to establish anything`,
		);
	}

	for (const check of checks) {
		if (check.status === 'failed') {
			problems.push(`${check.id} failed: ${check.error?.message ?? 'no message given'}`);
		}
	}

	for (const id of unrunCheckIds(report)) {
		if (!TOLERATED_UNRUN_CHECKS.includes(id)) {
			problems.push(`${id} could not run, so conformance is unproven`);
		}
	}

	if (report?.outcome === undefined) {
		// A 2025-era suite reports a bare boolean and no skip reasons, leaving
		// its own verdict as the only thing to go on.
		if (report?.passed !== true) {
			problems.push('the run reported itself as not passed');
		}
		return problems;
	}

	// An incomplete outcome is tolerable only because every check that could
	// not run has already been vetted against the allowlist above.
	if (report.outcome !== 'passed' && report.outcome !== 'incomplete') {
		problems.push(`the run outcome was ${report.outcome}`);
	}

	return problems;
}

function unrunCheckIds(report) {
	const checks = Array.isArray(report?.checks) ? report.checks : [];
	return checks.filter((check) => check.skipReason === 'could-not-run').map((check) => check.id);
}

async function main() {
	if (!fs.existsSync(DIST_ENTRY)) {
		console.error('dist/index.js not found — run `npm run build` first.');
		process.exitCode = 1;
		return;
	}

	const doctorOk = runDoctor();
	const conformanceOk = await runConformance();

	if (!doctorOk || !conformanceOk) {
		console.error('\nMCP checks failed.');
		process.exitCode = 1;
		return;
	}
	console.log('\n✓ MCP checks passed');
}

if (require.main === module) {
	main().catch((err) => {
		console.error(`Unexpected error running MCP checks: ${err?.message ?? err}`);
		process.exitCode = 1;
	});
}

module.exports = { judgeConformanceReport };
