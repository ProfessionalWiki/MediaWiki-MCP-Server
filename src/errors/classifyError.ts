export type ErrorCategory =
	| 'not_found'
	| 'permission_denied'
	| 'invalid_input'
	| 'conflict'
	| 'upstream_failure'
	| 'rate_limited'
	| 'authentication';

export interface ErrorClassifier {
	classify( err: unknown ): { category: ErrorCategory; code?: string };
}
