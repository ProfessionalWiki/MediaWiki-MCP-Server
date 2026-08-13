// Elapsed time — a cache TTL, a grace period, a logged duration — is measured
// with this rather than Date.now, which a host steps in both directions when it
// corrects its clock: backwards makes a deadline arrive late and an elapsed time
// come out negative, forwards makes a deadline arrive early. It counts
// milliseconds from process start and does not advance while the host is
// suspended, so it measures only time this process was actually running.
//
// Date.now remains correct for a point in time that means something outside the
// process: a token expiry, a JWT claim, a persisted or published timestamp.
export function monotonicNow(): number {
	// performance.now reads `this`, so it cannot be passed as a bare callback.
	return performance.now();
}
