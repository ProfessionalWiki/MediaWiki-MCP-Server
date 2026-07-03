import { describe, it, expect, vi, afterEach } from 'vitest';
import { silenceStdoutLogging } from '../src/index.js';

describe('silenceStdoutLogging', () => {
	const originalLog = console.log;
	const originalInfo = console.info;
	const originalDebug = console.debug;

	afterEach(() => {
		console.log = originalLog;
		console.info = originalInfo;
		console.debug = originalDebug;
	});

	it('redirects console.log/info/debug to console.error', () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		silenceStdoutLogging();
		console.log('from log');
		console.info('from info');
		console.debug('from debug');

		expect(errorSpy).toHaveBeenCalledWith('from log');
		expect(errorSpy).toHaveBeenCalledWith('from info');
		expect(errorSpy).toHaveBeenCalledWith('from debug');
		expect(errorSpy).toHaveBeenCalledTimes(3);
	});
});
