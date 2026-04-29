import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveShutdownGrace, registerShutdownHandlers } from '../../src/runtime/shutdown.js';

describe('resolveShutdownGrace', () => {
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.stubEnv('MCP_LOG_LEVEL', 'debug');
		stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
	});

	afterEach(() => {
		stderrSpy.mockRestore();
		vi.unstubAllEnvs();
	});

	function warningLines(): string[] {
		return stderrSpy.mock.calls
			.map((c) => String(c[0]))
			.filter((s) => s.includes('"level":"warning"'));
	}

	it('defaults to 10000 when unset', () => {
		expect(resolveShutdownGrace({})).toBe(10_000);
		expect(warningLines()).toHaveLength(0);
	});

	it('parses a valid integer string', () => {
		expect(resolveShutdownGrace({ MCP_SHUTDOWN_GRACE_MS: '5000' })).toBe(5_000);
		expect(warningLines()).toHaveLength(0);
	});

	it('accepts zero (immediate exit, no drain wait)', () => {
		expect(resolveShutdownGrace({ MCP_SHUTDOWN_GRACE_MS: '0' })).toBe(0);
		expect(warningLines()).toHaveLength(0);
	});

	it.each([['not-a-number'], ['-1'], ['1.5'], ['600001'], ['']])(
		'falls back with a warning for %s',
		(v) => {
			expect(resolveShutdownGrace({ MCP_SHUTDOWN_GRACE_MS: v })).toBe(10_000);
			const lines = warningLines();
			expect(lines).toHaveLength(1);
			// For non-empty values the raw string is preserved in the log line.
			// For the empty-string case, we verify the variable name appears instead,
			// because toContain('') is always true and provides no signal.
			expect(lines[0]).toContain(v !== '' ? v : 'MCP_SHUTDOWN_GRACE_MS');
		},
	);
});

interface FakeProcess {
	on: (signal: 'SIGTERM' | 'SIGINT', cb: () => void) => void;
	exit: (code: number) => void;
	signals: Map<string, () => void>;
	exitCalls: number[];
}

function fakeProcess(): FakeProcess {
	const signals = new Map<string, () => void>();
	const exitCalls: number[] = [];
	return {
		signals,
		exitCalls,
		on: (s, cb) => {
			signals.set(s, cb);
		},
		exit: (code) => {
			exitCalls.push(code);
		},
	};
}

function captureEvents(spy: ReturnType<typeof vi.spyOn>, name: string): Record<string, unknown>[] {
	return spy.mock.calls
		.map((c) => String(c[0]))
		.filter((s) => s.startsWith('{'))
		.map((s) => JSON.parse(s.replace(/\n$/, '')) as Record<string, unknown>)
		.filter((e) => e.event === name);
}

describe('registerShutdownHandlers (http)', () => {
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.stubEnv('MCP_LOG_LEVEL', 'debug');
		stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
	});

	afterEach(() => {
		stderrSpy.mockRestore();
		vi.unstubAllEnvs();
	});

	function setup(opts: { inFlight: number; sessions: number; graceMs?: number }) {
		const proc = fakeProcess();
		const closedSessions: string[] = [];
		const sessions: Record<string, { transport: { close: () => Promise<void> } }> = {};
		for (let i = 0; i < opts.sessions; i++) {
			const id = `s-${i}`;
			sessions[id] = {
				transport: {
					close: async () => {
						closedSessions.push(id);
					},
				},
			};
		}

		let httpClosed = false;
		const httpServer = {
			close: (cb?: () => void) => {
				httpClosed = true;
				if (cb) {
					cb();
				}
			},
			closeIdleConnections: () => {},
		};

		let count = opts.inFlight;
		const inFlight = {
			count: () => count,
			drain: () => {
				count = 0;
			},
		};

		registerShutdownHandlers({
			transport: 'http',
			graceMs: opts.graceMs ?? 10_000,
			// oxlint-disable-next-line typescript/no-explicit-any
			httpServer: httpServer as any,
			// oxlint-disable-next-line typescript/no-explicit-any
			sessions: sessions as any,
			inFlight,
			// oxlint-disable-next-line typescript/no-explicit-any
			process: proc as any,
			pollIntervalMs: 5,
		});

		return { proc, sessions, closedSessions, httpServer: { closed: () => httpClosed }, inFlight };
	}

	it('registers SIGTERM and SIGINT', () => {
		const { proc } = setup({ inFlight: 0, sessions: 0 });
		expect(proc.signals.has('SIGTERM')).toBe(true);
		expect(proc.signals.has('SIGINT')).toBe(true);
	});

	it('drains cleanly when in-flight reaches zero', async () => {
		const { proc, httpServer, closedSessions, inFlight } = setup({ inFlight: 2, sessions: 1 });
		proc.signals.get('SIGTERM')!();
		await new Promise((r) => setImmediate(r));
		inFlight.drain();
		await new Promise((r) => setTimeout(r, 20));

		expect(httpServer.closed()).toBe(true);
		expect(closedSessions).toEqual(['s-0']);
		expect(proc.exitCalls).toEqual([0]);

		const start = captureEvents(stderrSpy, 'shutdown');
		const done = captureEvents(stderrSpy, 'shutdown_complete');
		expect(start).toHaveLength(1);
		expect(start[0]).toMatchObject({
			signal: 'SIGTERM',
			transport: 'http',
			grace_ms: 10_000,
			in_flight_at_signal: 2,
			sessions_at_signal: 1,
		});
		expect(done).toHaveLength(1);
		expect(done[0]).toMatchObject({
			in_flight_drained: 2,
			sessions_closed: 1,
			grace_exceeded: false,
		});
		expect(typeof done[0].duration_ms).toBe('number');
	});

	it('exits 1 with grace_exceeded: true when in-flight is stuck', async () => {
		const { proc } = setup({ inFlight: 3, sessions: 0, graceMs: 30 });
		proc.signals.get('SIGINT')!();
		await new Promise((r) => setTimeout(r, 60));
		expect(proc.exitCalls).toEqual([1]);
		const done = captureEvents(stderrSpy, 'shutdown_complete');
		expect(done[0]).toMatchObject({
			grace_exceeded: true,
			in_flight_drained: 0,
		});
	});

	it('forces immediate exit on a second signal', async () => {
		const { proc } = setup({ inFlight: 5, sessions: 0, graceMs: 10_000 });
		proc.signals.get('SIGTERM')!();
		await new Promise((r) => setImmediate(r));
		proc.signals.get('SIGTERM')!();
		expect(proc.exitCalls[proc.exitCalls.length - 1]).toBe(1);
	});
});

describe('registerShutdownHandlers (stdio)', () => {
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.stubEnv('MCP_LOG_LEVEL', 'debug');
		stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
	});

	afterEach(() => {
		stderrSpy.mockRestore();
		vi.unstubAllEnvs();
	});

	it('closes the stdio transport and exits 0', async () => {
		const proc = fakeProcess();
		let closed = false;
		registerShutdownHandlers({
			transport: 'stdio',
			graceMs: 0,
			stdioTransport: {
				close: async () => {
					closed = true;
				},
			},
			// oxlint-disable-next-line typescript/no-explicit-any
			process: proc as any,
		});

		proc.signals.get('SIGTERM')!();
		await new Promise((r) => setImmediate(r));

		expect(closed).toBe(true);
		expect(proc.exitCalls).toEqual([0]);
		const events = captureEvents(stderrSpy, 'shutdown');
		const done = captureEvents(stderrSpy, 'shutdown_complete');
		expect(events[0]).toMatchObject({
			transport: 'stdio',
			signal: 'SIGTERM',
			grace_ms: 0,
		});
		expect(done[0]).toMatchObject({ transport: 'stdio', grace_exceeded: false });
	});
});
