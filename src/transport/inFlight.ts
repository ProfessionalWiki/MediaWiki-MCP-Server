import type { RequestHandler } from 'express';

export interface InFlightCounter {
	readonly middleware: RequestHandler;
	readonly count: () => number;
}

export function createInFlightCounter(): InFlightCounter {
	let n = 0;
	const middleware: RequestHandler = (_req, res, next) => {
		n++;
		res.on('close', () => {
			n--;
		});
		next();
	};
	return { middleware, count: () => n };
}
