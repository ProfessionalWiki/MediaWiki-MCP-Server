export function createRuntimeTokenMock(): {
	getRuntimeToken: () => string | undefined;
	_setRuntimeToken: ( t: string | undefined ) => void;
} {
	let token: string | undefined;
	return {
		getRuntimeToken: (): string | undefined => token,
		_setRuntimeToken: ( t: string | undefined ): void => {
			token = t;
		}
	};
}
