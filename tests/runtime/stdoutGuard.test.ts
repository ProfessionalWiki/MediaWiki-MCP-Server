import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Mwn } from 'mwn';
import { guardStdout } from '../../src/runtime/stdoutGuard.js';

interface StrayEvent {
	event?: string;
	text?: string;
	level?: string;
}

describe('guardStdout', () => {
	let originalConsole: Console;
	let stdoutSpy: ReturnType<typeof vi.spyOn>;
	let stderrSpy: ReturnType<typeof vi.spyOn>;
	let stderrChunks: string[];

	function strayEvents(): StrayEvent[] {
		return stderrChunks
			.flatMap((chunk) => chunk.split('\n'))
			.filter((line) => line !== '')
			.flatMap((line) => {
				try {
					return [JSON.parse(line) as StrayEvent];
				} catch {
					return [];
				}
			})
			.filter((entry) => entry.event === 'stray_stdout');
	}

	beforeEach(() => {
		vi.stubEnv('MCP_LOG_LEVEL', 'debug');
		originalConsole = globalThis.console;
		stderrChunks = [];
		stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
		stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
			stderrChunks.push(String(chunk));
			return true;
		});
	});

	afterEach(() => {
		globalThis.console = originalConsole;
		// Restore mwn's process-wide logging config for other suites.
		Mwn.setLoggingConfig({ stream: process.stdout });
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it('keeps console.log off stdout and reports it as a stray_stdout event', () => {
		guardStdout();

		console.log('hello from a dependency');

		expect(stdoutSpy).not.toHaveBeenCalled();
		expect(strayEvents()).toEqual([
			expect.objectContaining({ event: 'stray_stdout', text: 'hello from a dependency' }),
		]);
	});

	it('reports each line of a multi-line write separately and drops blank lines', () => {
		guardStdout();

		console.log('first\n\nsecond');

		expect(strayEvents().map((entry) => entry.text)).toEqual(['first', 'second']);
	});

	it('captures the other stdout-backed console methods', () => {
		guardStdout();

		console.info('via info');
		console.dir({ viaDir: true });

		const texts = strayEvents().map((entry) => entry.text);
		expect(texts).toContain('via info');
		expect(texts.some((text) => text?.includes('viaDir') === true)).toBe(true);
		expect(stdoutSpy).not.toHaveBeenCalled();
	});

	it('leaves console.error on stderr untouched', () => {
		guardStdout();

		console.error('boom');

		expect(stdoutSpy).not.toHaveBeenCalled();
		expect(strayEvents()).toEqual([]);
		expect(stderrChunks.join('')).toContain('boom');
	});

	it('emits stray output at warning level', () => {
		guardStdout();

		console.log('noise');

		expect(strayEvents()[0]?.level).toBe('warning');
	});

	it('routes mwn log lines off stdout (#483)', () => {
		guardStdout();

		Mwn.log('[S] [mwn] Login successful: TestBot@mcp@https://example.org/w/api.php');
		Mwn.log('[W] Warning received from API: main: Subscribe to the mediawiki-api-announce list');

		expect(stdoutSpy).not.toHaveBeenCalled();
		const texts = strayEvents().map((entry) => entry.text ?? '');
		expect(texts.some((text) => text.includes('Login successful'))).toBe(true);
		expect(texts.some((text) => text.includes('Warning received from API'))).toBe(true);
	});

	it('strips colour codes from redirected mwn output', () => {
		vi.stubEnv('FORCE_COLOR', '3');
		guardStdout();

		Mwn.log('[S] [mwn] Login successful: TestBot@mcp');

		const text = strayEvents()[0]?.text ?? '';
		expect(text).not.toContain('');
	});

	it('keeps every stderr line valid JSON so log tailing still parses', () => {
		guardStdout();

		Mwn.log('[2026-07-23 16:48:43] [W] Warning received from API');
		console.log('{ request: { method: undefined } }');

		const lines = stderrChunks.flatMap((chunk) => chunk.split('\n')).filter((line) => line !== '');
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
	});

	it('is idempotent', () => {
		guardStdout();
		guardStdout();

		console.log('once');

		expect(strayEvents()).toHaveLength(1);
		expect(stdoutSpy).not.toHaveBeenCalled();
	});

	it('falls back to raw stderr rather than losing output when logging throws', () => {
		guardStdout();
		// An unusable MCP_LOG_LEVEL makes the structured logger throw. Node's
		// Console swallows sink errors, so without a fallback the line vanishes.
		vi.stubEnv('MCP_LOG_LEVEL', 'not-a-level');

		expect(() => console.log('must survive')).not.toThrow();

		expect(stdoutSpy).not.toHaveBeenCalled();
		expect(stderrChunks.join('')).toContain('must survive');
	});

	it('stays usable after a write that throws', () => {
		guardStdout();
		// Force the fallback path, then make it throw too. A write that leaves the
		// stream mid-write would buffer every later line in silence.
		vi.stubEnv('MCP_LOG_LEVEL', 'not-a-level');
		stderrSpy.mockImplementationOnce(() => {
			throw new Error('EPIPE');
		});

		console.log('lost to a broken stderr');
		vi.stubEnv('MCP_LOG_LEVEL', 'debug');
		console.log('written after the failure');

		expect(strayEvents().map((entry) => entry.text)).toContain('written after the failure');
	});
});
