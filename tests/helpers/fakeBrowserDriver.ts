// tests/helpers/fakeBrowserDriver.ts
import type { Mock } from 'vitest';

export type DriverBehaviour = 'consent' | 'deny' | 'tampered_state';

/**
 * Returns a mock that, given the auth URL emitted by browserAuth, synthesises
 * the user-consent step against the fake AS and hits the loopback callback.
 *
 * `tampered_state` simulates a malicious or buggy redirect that returns a
 * state value different from the one the server issued — exercises the CSRF
 * guard.
 */
export function fakeBrowserDriver(_asUrl: string, behaviour: DriverBehaviour = 'consent'): Mock {
	return (async (authUrl: string): Promise<void> => {
		const u = new URL(authUrl);
		const state = u.searchParams.get('state')!;
		const redirectUri = u.searchParams.get('redirect_uri')!;
		const cb = new URL(redirectUri);
		if (behaviour === 'consent') {
			cb.searchParams.set('code', 'CODE-' + state.slice(0, 6));
			cb.searchParams.set('state', state);
		} else if (behaviour === 'deny') {
			cb.searchParams.set('error', 'access_denied');
			cb.searchParams.set('state', state);
		} else {
			cb.searchParams.set('code', 'CODE-' + state.slice(0, 6));
			cb.searchParams.set('state', 'attacker-supplied-state');
		}
		await fetch(cb.toString()).catch(() => undefined);
	}) as unknown as Mock;
}
