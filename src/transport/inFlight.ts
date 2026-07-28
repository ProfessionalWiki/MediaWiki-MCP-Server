import type { Request, RequestHandler } from 'express';

export interface InFlightCounter {
	readonly middleware: RequestHandler;
	readonly count: () => number;
}

// A subscriptions/listen POST opens a held-open SSE stream, not work to
// drain: counting it would pin the counter above zero for as long as any
// client listens, wedging shutdown at the grace ceiling. The handler closes
// those streams gracefully after the drain instead. express.json() has
// already parsed the body by the time this middleware runs.
function isListenRequest(req: Request): boolean {
	if (req.method !== 'POST') {
		return false;
	}
	const body: unknown = req.body;
	return (
		typeof body === 'object' &&
		body !== null &&
		!Array.isArray(body) &&
		(body as { method?: unknown }).method === 'subscriptions/listen'
	);
}

export function createInFlightCounter(): InFlightCounter {
	let n = 0;
	const middleware: RequestHandler = (req, res, next) => {
		if (isListenRequest(req)) {
			next();
			return;
		}
		n++;
		res.on('close', () => {
			n--;
		});
		next();
	};
	return { middleware, count: () => n };
}
