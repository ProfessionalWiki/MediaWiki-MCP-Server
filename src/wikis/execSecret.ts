import { execFile } from 'node:child_process';
import type { ExecSecret } from '../config/loadConfig.js';
import { CredentialResolutionError } from '../errors/credentialResolutionError.js';

const TIMEOUT_MS = 30_000;
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
			return `Could not resolve ${descriptor}: command "${command}" timed out after ${TIMEOUT_MS / 1000}s. If it prompts for interactive approval (e.g. a 1Password unlock), approve the prompt and retry — the command re-runs on the next attempt.`;
		}
		if (typeof code === 'number' && code !== 0) {
			return `Could not resolve ${descriptor}: command "${command}" exited with status ${code}. stderr: ${stderr.slice(0, STDERR_LIMIT)}`;
		}
	}
	return `Could not resolve ${descriptor}: ${err instanceof Error ? err.message : typeof err === 'string' ? err : String(err)}`;
}

// Serialize exec-secret command runs process-wide. An interactive credential
// helper — e.g. `op read` backed by the 1Password desktop app — prompts the
// user to unlock on its first run; once that completes, the helper caches a
// session that later runs reuse silently. Running them concurrently instead
// races every run against that one unlock, so each prompts: resolving secrets
// for N wikis at once (e.g. list-wikis fanning out over every wiki) yields N
// dialogs. A single in-process queue collapses that to one prompt — the first
// run unlocks, the rest reuse the warm session.
//
// The per-run timeout starts when execFile is invoked (on dequeue), not while
// a run waits its turn, so a slow human unlock on the first prompt never eats
// into a queued run's timeout budget.
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
	const run = queue.then(task);
	// Advance the chain past this run regardless of its outcome. The rejection
	// handler here also marks `run`'s rejection as observed, so a caller that
	// forgets to await never triggers an unhandled-rejection warning.
	queue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
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
 * that reads stdin sees EOF instead of hanging until the timeout. Runs are
 * serialized process-wide (see `enqueue`) so an interactive credential helper
 * prompts once rather than once per concurrent resolution. Failure messages
 * carry only the command name and truncated stderr — never stdout, never the
 * resolved secret.
 */
export async function runExecSecret(spec: ExecSecret, descriptor: string): Promise<string> {
	const { command, args } = spec.exec;
	const stdout = await enqueue(
		() =>
			new Promise<string>((resolve, reject) => {
				const child = execFile(
					command,
					args,
					{ timeout: TIMEOUT_MS, encoding: 'utf-8' },
					(err, out, errOut) => {
						if (err) {
							reject(
								new CredentialResolutionError(
									failureMessage(err, errOut ?? '', command, descriptor),
								),
							);
							return;
						}
						resolve(out);
					},
				);
				child.stdin?.end();
			}),
	);

	const trimmed = stdout.replace(/\r?\n+$/, '');
	if (trimmed === '') {
		throw new CredentialResolutionError(
			`Could not resolve ${descriptor}: command "${command}" produced no output`,
		);
	}
	return trimmed;
}
