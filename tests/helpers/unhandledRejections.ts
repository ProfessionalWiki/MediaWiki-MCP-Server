import { onTestFinished } from 'vitest';

// Collects unhandled rejections for the duration of the calling test, removing
// the listener however the test ends. Vitest reports run-level unhandled errors
// without attributing them to a test, so a test that asserts one of its own
// watches for it here. The production symptom is a dead process, which never
// reaches an assertion at all.
export function watchUnhandledRejections(): unknown[] {
	const seen: unknown[] = [];
	const listener = (reason: unknown) => {
		seen.push(reason);
	};
	process.on('unhandledRejection', listener);
	onTestFinished(() => {
		process.off('unhandledRejection', listener);
	});
	return seen;
}
