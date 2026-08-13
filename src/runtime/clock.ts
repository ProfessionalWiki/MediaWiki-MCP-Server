// Elapsed time — a cache TTL, a grace period, a logged duration — is measured
// with this rather than Date.now, which steps in both directions when a host
// corrects its clock. It counts milliseconds from process start and only ever
// moves forwards.
//
// Date.now stays correct for a point in time that means something outside this
// run of the process: a JWT claim, a timestamp that is published, or a token
// expiry that has to still mean something after a restart.
export function monotonicNow(): number {
	// performance.now reads `this`, so it cannot be passed as a bare callback.
	return performance.now();
}
