import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ErrorEnvelope } from '../results/schemas.ts';
import type { ErrorCategory } from '../errors/classifyError.ts';
import { formatPayload } from './format.ts';

export interface ResponseFormatter {
	ok(payload: unknown): CallToolResult;
	error(category: ErrorCategory, message: string, code?: string): CallToolResult;
	notFound(message: string, code?: string): CallToolResult;
	invalidInput(message: string): CallToolResult;
	conflict(message: string, code?: string): CallToolResult;
	permissionDenied(message: string, code?: string): CallToolResult;
}

export function structuredResult(data: unknown): CallToolResult {
	return {
		content: [{ type: 'text', text: formatPayload(data) }],
		// structuredContent mirrors the typed payload so the dispatcher can detect
		// truncation via the `truncation` field without reparsing the rendered text.
		structuredContent: data,
	};
}

export function errorResult(
	category: ErrorCategory,
	message: string,
	code?: string,
): CallToolResult {
	// Error envelopes ride as JSON in content[0].text — same channel as the
	// success-path prose — paired with isError: true. Clients distinguish
	// success from error by the isError flag and parse the envelope from the
	// text block when they want the typed shape.
	const envelope: ErrorEnvelope =
		code !== undefined ? { category, message, code } : { category, message };
	return {
		content: [{ type: 'text', text: JSON.stringify(envelope) }],
		isError: true,
	};
}

export class ResponseFormatterImpl implements ResponseFormatter {
	public ok(payload: unknown): CallToolResult {
		return structuredResult(payload);
	}

	public error(category: ErrorCategory, message: string, code?: string): CallToolResult {
		return errorResult(category, message, code);
	}

	public notFound(message: string, code?: string): CallToolResult {
		return this.error('not_found', message, code);
	}

	public invalidInput(message: string): CallToolResult {
		return this.error('invalid_input', message);
	}

	public conflict(message: string, code?: string): CallToolResult {
		return this.error('conflict', message, code);
	}

	public permissionDenied(message: string, code?: string): CallToolResult {
		return this.error('permission_denied', message, code);
	}
}
