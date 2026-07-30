import { vi, type Mock } from 'vitest';
import type { Logger } from '../../src/runtime/logger.ts';

export type FakeLogger = { [K in keyof Logger]: Mock<Logger[K]> };

// Every level the real logger exposes, so a test double stays complete when a
// level is added: the return type is keyed off Logger, so a missing spy is a
// typecheck failure here rather than a runtime crash in whichever test first
// hits the new level.
export function fakeLogger(overrides: Partial<FakeLogger> = {}): FakeLogger {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		notice: vi.fn(),
		warning: vi.fn(),
		error: vi.fn(),
		critical: vi.fn(),
		alert: vi.fn(),
		emergency: vi.fn(),
		...overrides,
	};
}
