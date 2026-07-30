import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emitTelemetryEvent, logger, type LogLevel } from '../../src/runtime/logger.ts';

describe('logger', () => {
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.stubEnv('MCP_LOG_LEVEL', 'debug');
		stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
	});

	afterEach(() => {
		stderrSpy.mockRestore();
		vi.unstubAllEnvs();
	});

	describe('stderr output (JSON per line)', () => {
		function lastJson(): Record<string, unknown> {
			const calls = stderrSpy.mock.calls;
			expect(calls.length).toBeGreaterThan(0);
			const raw = String(calls[calls.length - 1][0]);
			expect(raw.endsWith('\n')).toBe(true);
			return JSON.parse(raw.slice(0, -1)) as Record<string, unknown>;
		}

		it('emits a JSON line with ts, level, and message at info', () => {
			logger.info('listening on 127.0.0.1:3000');
			const obj = lastJson();
			expect(obj.level).toBe('info');
			expect(obj.message).toBe('listening on 127.0.0.1:3000');
			expect(obj.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		});

		it('records the level field for non-info levels', () => {
			logger.warning('plaintext credential');
			expect(lastJson().level).toBe('warning');
		});

		it('merges data fields at the top level', () => {
			logger.error('tool registration failed', { tool: 'get-page', error: 'boom' });
			const obj = lastJson();
			expect(obj.message).toBe('tool registration failed');
			expect(obj.tool).toBe('get-page');
			expect(obj.error).toBe('boom');
		});

		it('omits the message field when message is empty', () => {
			logger.info('', { event: 'tool_call', tool: 'get-page' });
			const obj = lastJson();
			expect('message' in obj).toBe(false);
			expect(obj.event).toBe('tool_call');
			expect(obj.tool).toBe('get-page');
		});

		it('overrides reserved keys (ts, level, message) supplied via data', () => {
			logger.info('real', { ts: 'fake', level: 'fake', message: 'fake', other: 'kept' });
			const obj = lastJson();
			expect(obj.message).toBe('real');
			expect(obj.level).toBe('info');
			expect(obj.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
			expect(obj.other).toBe('kept');
		});

		it.each<[LogLevel]>([
			['debug'],
			['info'],
			['notice'],
			['warning'],
			['error'],
			['critical'],
			['alert'],
			['emergency'],
		])('%s emits the matching level field', (level) => {
			logger[level]('x');
			expect(lastJson().level).toBe(level);
		});
	});

	describe('MCP_LOG_LEVEL threshold', () => {
		it('drops below-threshold stderr writes', () => {
			vi.stubEnv('MCP_LOG_LEVEL', 'warning');
			logger.info('should be filtered');
			expect(stderrSpy).not.toHaveBeenCalled();
		});

		it('emits at-or-above-threshold messages', () => {
			vi.stubEnv('MCP_LOG_LEVEL', 'warning');
			logger.warning('kept');
			logger.error('also kept');
			expect(stderrSpy).toHaveBeenCalledTimes(2);
		});

		it('silent drops every level including emergency', () => {
			vi.stubEnv('MCP_LOG_LEVEL', 'silent');
			logger.debug('no');
			logger.info('no');
			logger.warning('no');
			logger.error('no');
			logger.emergency('no');
			expect(stderrSpy).not.toHaveBeenCalled();
		});

		it('unset env behaves like debug (everything emits)', () => {
			vi.stubEnv('MCP_LOG_LEVEL', '');
			logger.debug('kept');
			logger.info('kept');
			expect(stderrSpy).toHaveBeenCalledTimes(2);
		});

		it('throws on first emit with an invalid value', () => {
			vi.stubEnv('MCP_LOG_LEVEL', 'verbose');
			expect(() => logger.info('x')).toThrow(
				/MCP_LOG_LEVEL.*verbose.*debug.*info.*notice.*warning.*error.*critical.*alert.*emergency.*silent/s,
			);
		});

		it('throws on prototype-chain keys like toString', () => {
			vi.stubEnv('MCP_LOG_LEVEL', 'toString');
			expect(() => logger.info('x')).toThrow(/MCP_LOG_LEVEL.*toString/s);
		});

		it('gates emitTelemetryEvent with the same threshold', () => {
			vi.stubEnv('MCP_LOG_LEVEL', 'warning');
			emitTelemetryEvent('info', { event: 'tool_call', tool: 'x' });
			expect(stderrSpy).not.toHaveBeenCalled();
			emitTelemetryEvent('error', { event: 'tool_call', tool: 'x' });
			expect(stderrSpy).toHaveBeenCalledTimes(1);
		});
	});
});
