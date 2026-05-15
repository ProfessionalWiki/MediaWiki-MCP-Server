import { execFile } from 'node:child_process';
import type { ExecSecret } from '../config/loadConfig.js';
import { CredentialResolutionError } from '../errors/credentialResolutionError.js';

const TIMEOUT_MS = 10_000;
const STDERR_LIMIT = 200;

function failureMessage(err: unknown, stderr: string, command: string, descriptor: string): string {
	if (err !== null && typeof err === 'object') {
		const code = (err as { code?: unknown }).code;
		const killed = (err as { killed?: unknown }).killed;
		const signal = (err as { signal?: unknown }).signal;

		if (code === 'ENOENT') {
			return `Could not resolve ${descriptor}: command "${command}" not found`;
		}
		if (killed === true || signal === 'SIGTERM' || code === 'ETIMEDOUT') {
			return `Could not resolve ${descriptor}: command "${command}" timed out after 10s`;
		}
		if (typeof code === 'number' && code !== 0) {
			return `Could not resolve ${descriptor}: command "${command}" exited with status ${code}. stderr: ${stderr.slice(0, STDERR_LIMIT)}`;
		}
	}
	return `Could not resolve ${descriptor}: ${err instanceof Error ? err.message : typeof err === 'string' ? err : String(err)}`;
}

/**
 * Run an {exec:…} credential command and return its trimmed stdout.
 *
 * `descriptor` is a human-readable label for the credential being fetched
 * (e.g. `the "token" credential for wiki "x"`) — it appears in error messages
 * so the caller does not need to re-wrap the thrown error.
 *
 * Uses the async (callback) form of execFile so a slow command never blocks
 * the Node event loop. The child's stdin is closed immediately so a command
 * that reads stdin sees EOF instead of hanging until the timeout. Failure
 * messages carry only the command name and truncated stderr — never stdout,
 * never the resolved secret.
 */
export async function runExecSecret(spec: ExecSecret, descriptor: string): Promise<string> {
	const { command, args } = spec.exec;
	const stdout = await new Promise<string>((resolve, reject) => {
		const child = execFile(
			command,
			args,
			{ timeout: TIMEOUT_MS, encoding: 'utf-8' },
			(err, out, errOut) => {
				if (err) {
					reject(
						new CredentialResolutionError(failureMessage(err, errOut ?? '', command, descriptor)),
					);
					return;
				}
				resolve(out);
			},
		);
		child.stdin?.end();
	});

	const trimmed = stdout.replace(/\r?\n+$/, '');
	if (trimmed === '') {
		throw new CredentialResolutionError(
			`Could not resolve ${descriptor}: command "${command}" produced no output`,
		);
	}
	return trimmed;
}
