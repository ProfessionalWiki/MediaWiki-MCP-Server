/** How far a call got before its budget ran out. */
export type WikiTimeoutPhase = 'connecting' | 'calling';

/**
 * Thrown when a wiki request is abandoned for exhausting its time budget rather
 * than for the caller cancelling. `disableRetry` stops mwn's ladder sleeping
 * `retryPause` and re-issuing against a signal that has already fired.
 */
export class WikiTimeoutError extends Error {
	public readonly disableRetry = true;

	public constructor(
		timeoutMs: number,
		public readonly phase: WikiTimeoutPhase,
	) {
		const seconds = Math.round(timeoutMs / 1000);
		super(
			phase === 'connecting'
				? `Gave up trying to reach the wiki after ${seconds} seconds`
				: `Gave up waiting for the wiki after ${seconds} seconds`,
		);
		this.name = 'WikiTimeoutError';
	}
}
