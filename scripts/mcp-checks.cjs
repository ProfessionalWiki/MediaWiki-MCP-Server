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
			{ stdio: 'inherit' },
		);

		if (result.status !== 0) {
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

main().catch((err) => {
	console.error(`Unexpected error running MCP checks: ${err?.message ?? err}`);
	process.exitCode = 1;
});
