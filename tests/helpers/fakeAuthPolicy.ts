import type { AuthPolicy } from '../../src/runtime/authShape.ts';

// Stdio, no opt-ins and no hosted proxy, unless the suite says otherwise.
export function fakeAuthPolicy(overrides: Partial<AuthPolicy> = {}): AuthPolicy {
	return {
		transport: 'stdio',
		bearerPassthrough: false,
		staticFallback: false,
		hostedProxy: null,
		...overrides,
	};
}
