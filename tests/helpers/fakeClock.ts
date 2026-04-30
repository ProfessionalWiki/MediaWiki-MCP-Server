// tests/helpers/fakeClock.ts

export interface FakeClock {
	now(): number;
	advance(ms: number): void;
}

export function fakeClock(startMs = 1_700_000_000_000): FakeClock {
	let cur = startMs;
	return {
		now: () => cur,
		advance: (ms: number) => {
			cur += ms;
		},
	};
}
