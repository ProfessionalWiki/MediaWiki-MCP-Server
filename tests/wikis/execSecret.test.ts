import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';

vi.mock('node:child_process');

import { runExecSecret } from '../../src/wikis/execSecret.js';
import { CredentialResolutionError } from '../../src/errors/credentialResolutionError.js';

const SENTINEL = 'SECRET-NEVER-LEAK';
const descriptor = 'the "token" credential for wiki "w"';

/**
 * Drive the mocked execFile callback. runExecSecret calls execFile with
 * (file, args, options, callback) and then `.stdin?.end()` on the returned
 * child; we capture the callback, invoke it, and return a stub child.
 */
function mockExecFile(
	behaviour: (cb: (err: unknown, stdout: string, stderr: string) => void) => void,
) {
	vi.mocked(execFile).mockImplementation(((...callArgs: unknown[]) => {
		const cb = callArgs[callArgs.length - 1] as (e: unknown, o: string, s: string) => void;
		behaviour(cb);
		return { stdin: { end: () => {} } } as unknown as ReturnType<typeof execFile>;
	}) as unknown as typeof execFile);
}

describe('runExecSecret', () => {
	beforeEach(() => {
		vi.mocked(execFile).mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('returns the trimmed stdout on success', async () => {
		mockExecFile((cb) => cb(null, 'resolved-secret\n', ''));
		await expect(
			runExecSecret({ exec: { command: 'op', args: ['read', 'x'] } }, descriptor),
		).resolves.toBe('resolved-secret');
	});

	it('throws CredentialResolutionError when the command is not found', async () => {
		mockExecFile((cb) => {
			const e = new Error('spawn op ENOENT') as NodeJS.ErrnoException;
			e.code = 'ENOENT';
			cb(e, '', '');
		});
		await expect(
			runExecSecret({ exec: { command: 'op', args: [] } }, descriptor),
		).rejects.toBeInstanceOf(CredentialResolutionError);
		await expect(runExecSecret({ exec: { command: 'op', args: [] } }, descriptor)).rejects.toThrow(
			'command "op" not found',
		);
	});

	it('throws CredentialResolutionError on timeout', async () => {
		mockExecFile((cb) => {
			const e = new Error('timed out') as Error & { killed?: boolean; signal?: string };
			e.killed = true;
			e.signal = 'SIGTERM';
			cb(e, '', '');
		});
		await expect(
			runExecSecret({ exec: { command: 'slow', args: [] } }, descriptor),
		).rejects.toThrow('timed out after 10s');
	});

	it('throws CredentialResolutionError on non-zero exit with truncated stderr', async () => {
		mockExecFile((cb) => {
			const e = new Error('failed') as Error & { code?: number };
			e.code = 1;
			cb(e, '', 'auth required');
		});
		await expect(runExecSecret({ exec: { command: 'op', args: [] } }, descriptor)).rejects.toThrow(
			'exited with status 1. stderr: auth required',
		);
	});

	it('truncates long stderr to 200 chars', async () => {
		mockExecFile((cb) => {
			const e = new Error('failed') as Error & { code?: number };
			e.code = 2;
			cb(e, '', 'X'.repeat(500));
		});
		try {
			await runExecSecret({ exec: { command: 'op', args: [] } }, descriptor);
			expect.fail('should have thrown');
		} catch (err) {
			expect((err as Error).message.match(/X/g)?.length ?? 0).toBeLessThanOrEqual(200);
		}
	});

	it('throws when the command produces no output', async () => {
		mockExecFile((cb) => cb(null, '\n\n', ''));
		await expect(runExecSecret({ exec: { command: 'op', args: [] } }, descriptor)).rejects.toThrow(
			'produced no output',
		);
	});

	it('never leaks the command stdout into a failure message', async () => {
		mockExecFile((cb) => {
			const e = new Error('failed') as Error & { code?: number };
			e.code = 1;
			cb(e, SENTINEL, 'auth needed');
		});
		try {
			await runExecSecret({ exec: { command: 'op', args: [] } }, descriptor);
			expect.fail('should have thrown');
		} catch (err) {
			expect((err as Error).message).not.toContain(SENTINEL);
		}
	});
});
