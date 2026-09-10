import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ErrorEnvelope } from '../results/schemas.ts';
import type { ErrorCategory } from '../errors/classifyError.ts';
import { formatPayload } from './format.ts';
import { truncationSentence, type TruncationInfo } from './truncation.ts';

export interface ResponseFormatter {
	ok(payload: unknown): CallToolResult;
	error(category: ErrorCategory, message: string, code?: string): CallToolResult;
	notFound(message: string, code?: string): CallToolResult;
	invalidInput(message: string): CallToolResult;
	conflict(message: string, code?: string): CallToolResult;
	permissionDenied(message: string, code?: string): CallToolResult;
}

// The marker is a sentence once rendered, so it stays on its label's line
// however long it runs.
const PROSE_KEYS: ReadonlySet<string> = new Set(['truncation']);

const TRUNCATION_REASONS = new Set([
	'more-available',
	'capped-no-continuation',
	'content-truncated',
]);

function isTruncationInfo(value: unknown): value is TruncationInfo {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const reason = (value as { reason?: unknown }).reason;
	return typeof reason === 'string' && TRUNCATION_REASONS.has(reason);
}

/**
 * Replaces every truncation marker in a payload with its sentence, for the
 * prose channel alone.
 *
 * The generic formatter renders a marker field by field, which spells internal
 * field names as labels and leaves a caller to assemble its own follow-up call
 * out of a nested `Param`/`Value` pair. One sentence states it. The payload is
 * walked rather than checked at its root because `get-pages` carries a marker
 * per entry as well as one for the response.
 */
function withProseTruncation(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(withProseTruncation);
	}
	if (typeof value !== 'object' || value === null) {
		return value;
	}
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [
			key,
			key === 'truncation' && isTruncationInfo(entry)
				? truncationSentence(entry)
				: withProseTruncation(entry),
		]),
	);
}

export function structuredResult(data: unknown): CallToolResult {
	return {
		content: [
			{
				type: 'text',
				text: formatPayload(withProseTruncation(data), { inlineKeys: PROSE_KEYS }),
			},
		],
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
