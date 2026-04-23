const REDACTED = '[REDACTED]';

const SENSITIVE_HEADER_PATTERN = /^(?:proxy-)?authorization$/i;

function redactHeadersObject( obj: unknown ): void {
	if ( !obj || typeof obj !== 'object' ) {
		return;
	}
	const headers = ( obj as Record<string, unknown> ).headers;
	if ( !headers || typeof headers !== 'object' ) {
		return;
	}
	for ( const key of Object.keys( headers ) ) {
		if ( SENSITIVE_HEADER_PATTERN.test( key ) ) {
			( headers as Record<string, unknown> )[ key ] = REDACTED;
		}
	}
}

export function redactAuthorizationHeader( err: unknown, token?: string ): void {
	if ( !( err instanceof Error ) ) {
		return;
	}
	const e = err as unknown as Record<string, unknown>;
	redactHeadersObject( e.request );
	redactHeadersObject( e.config );
	if ( e.response && typeof e.response === 'object' ) {
		redactHeadersObject( ( e.response as Record<string, unknown> ).config );
	}
	// replaceAll with a string pattern does literal (non-regex) replacement —
	// do not "refactor" this to a RegExp, which would misbehave on special chars in the token.
	if ( token && typeof err.message === 'string' && err.message.includes( token ) ) {
		err.message = err.message.replaceAll( token, REDACTED );
	}
	if ( token && typeof err.stack === 'string' && err.stack.includes( token ) ) {
		err.stack = err.stack.replaceAll( token, REDACTED );
	}
}

export function wrapMwnErrors<T extends object>( target: T, token?: string ): T {
	return new Proxy( target, {
		get( obj, prop, receiver ): unknown {
			const value = Reflect.get( obj, prop, receiver );
			if ( typeof value !== 'function' ) {
				return value;
			}
			return function ( this: unknown, ...args: unknown[] ): unknown {
				try {
					const result = ( value as ( ...a: unknown[] ) => unknown ).apply(
						this === receiver ? obj : this,
						args
					);
					if ( result && typeof ( result as Promise<unknown> ).then === 'function' ) {
						return ( result as Promise<unknown> ).catch( ( err: unknown ) => {
							redactAuthorizationHeader( err, token );
							throw err;
						} );
					}
					return result;
				} catch ( err ) {
					redactAuthorizationHeader( err, token );
					throw err;
				}
			};
		}
	} );
}
