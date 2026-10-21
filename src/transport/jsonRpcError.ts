import type { Response } from 'express';

/**
 * Answers with a JSON-RPC error. `id` is left out when the request has none this
 * layer can attribute the error to: this revision's error shape admits only a
 * string or a number, with no value for "unknown".
 */
export function sendJsonRpcError(
	res: Response,
	status: number,
	error: { code: number; message: string },
	id?: string | number,
): void {
	res.status(status).json({ jsonrpc: '2.0', error, ...(id === undefined ? {} : { id }) });
}
