import { logger } from './logger.js';

const DEFAULT_GRACE_MS = 10_000;
const MAX_GRACE_MS = 600_000;

export function resolveShutdownGrace( env: NodeJS.ProcessEnv ): number {
	const raw = env.MCP_SHUTDOWN_GRACE_MS;
	if ( raw === undefined ) {
		return DEFAULT_GRACE_MS;
	}
	const n = Number( raw );
	if ( raw === '' || !Number.isInteger( n ) || n < 0 || n > MAX_GRACE_MS ) {
		logger.warning(
			`Ignoring invalid MCP_SHUTDOWN_GRACE_MS=${ JSON.stringify( raw ) }; ` +
			`expected an integer between 0 and ${ MAX_GRACE_MS }. Using default ${ DEFAULT_GRACE_MS }ms.`
		);
		return DEFAULT_GRACE_MS;
	}
	return n;
}
